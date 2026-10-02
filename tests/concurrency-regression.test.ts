import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareGrading, preparePlan } from '../src/config.js';
import { resumeEvaluation, runEvaluation } from '../src/execution.js';
import { gradeEvaluation } from '../src/grading.js';
import { buildReport } from '../src/report.js';
import { fileHash, listArtifacts } from '../src/storage.js';

for(const caseCount of [40,300]) test(`${caseCount*3} concurrent multi-turn trials and ${caseCount*12} repeated grades preserve isolation, coverage and idempotence`,{timeout:180000},async()=> {
  const trialCount=caseCount*3,gradeCount=trialCount*4;
  const directory=await mkdtemp(path.join(tmpdir(),'one-eval-concurrency-regression-'));
  const target=path.join(directory,'target.mjs'),judge=path.join(directory,'judge.mjs');
  const targetLog=path.join(directory,'target.jsonl'),judgeLog=path.join(directory,'judge.jsonl');
  await writeFile(target,`import {appendFile} from 'node:fs/promises';
export default class Target {
  constructor(options){this.log=options.config.log;this.turn=0;this.first=undefined;}
  id(){return 'independent-instance'}
  async callApi(prompt,context){const messages=JSON.parse(prompt);this.first??=messages[0].content;
    if(this.first!==messages[0].content||messages.length!==this.turn*2+1)throw new Error('Cross-trial provider state leak');
    const turn=++this.turn;await new Promise(resolve=>setTimeout(resolve,(context.vars.repeat+turn)%4));
    await appendFile(this.log,JSON.stringify({sessionId:context.vars.sessionId,turn})+'\\n');
    return {output:this.first+'|'+turn};}
}
`);
  await writeFile(judge,`import {appendFile} from 'node:fs/promises';
export default class Judge {constructor(options){this.log=options.config.log;this.calls=0;}id(){return 'fresh-judge'}
  async callApi(prompt){if(++this.calls!==1)throw new Error('Grading context reused');const input=JSON.parse(JSON.parse(prompt)[1].content);
    await appendFile(this.log,JSON.stringify({id:input.case.id,repeat:input.repeat,judge:input.judgeId})+'\\n');
    return {output:JSON.stringify({status:'scored',score:input.artifact.output===input.case.reference?1:0,reason:'Independent reference comparison'})};}}
`);
  const cases=Array.from({length:caseCount},(_,index)=>({id:`case-${index}`,input:`canary-${index}-上海🌏\nquoted "value"`,reference:`canary-${index}-上海🌏\nquoted "value"|2`,conversation:{mode:'scripted',turns:['Recall the current trial value']}}));
  const config=path.join(directory,'eval.json');
  await writeFile(config,JSON.stringify({version:1,name:'Concurrent canaries',cases,target:{kind:'provider',provider:{id:`file://${target}`,config:{log:targetLog}},isolation:{mode:'stateless',scope:'independent',evidence:'Separate local provider instance with session canary oracle'},retrySafe:true},execution:{repeats:3,concurrency:12,timeoutMs:15000,maxAttempts:trialCount}}));
  const run=path.join(directory,'run');const result=await runEvaluation(await preparePlan(config),run);
  assert.equal(result.completed,trialCount);assert.equal(result.failed,0);
  const artifacts=await listArtifacts(run);assert.equal(new Set(artifacts.map(item=>item.sessionId)).size,trialCount);
  assert.ok(artifacts.every(item=>item.messages.length===4&&item.output===cases.find(row=>row.id===item.caseId)!.reference));
  const judges=path.join(directory,'judges.json');
  await writeFile(judges,JSON.stringify({version:1,judges:['a','b'].map(id=>({id,kind:'llm',provider:{id:`file://${judge}`,config:{log:judgeLog}},prompt:'Compare saved response and reference.',repeats:2})),concurrency:12,timeoutMs:10000,maxAttempts:gradeCount}));
  const grading=await prepareGrading(judges);const grades=await gradeEvaluation(run,grading) as {scored:number};assert.equal(grades.scored,gradeCount);
  const report=await buildReport(run);assert.equal(report.complete,true);assert.equal(report.overall,1);
  const gradeFolder=path.join(run,'grades',grading.versionHash,'records');
  const artifactsFolder=path.join(run,'artifacts');
  const snapshot=async()=> {
    const files=(await readdir(artifactsFolder)).map(name=>path.join(artifactsFolder,name)).concat((await readdir(gradeFolder)).map(name=>path.join(gradeFolder,name))).sort();
    const values:string[][]=[];
    for(let index=0;index<files.length;index+=64)values.push(...await Promise.all(files.slice(index,index+64).map(async file=>[file,await fileHash(file)])));
    return values;
  };
  const before=await snapshot();const targetBefore=await readFile(targetLog,'utf8'),judgeBefore=await readFile(judgeLog,'utf8');
  assert.equal(targetBefore.trim().split('\n').length,trialCount*2);assert.equal(judgeBefore.trim().split('\n').length,gradeCount);
  await resumeEvaluation(run,{retryErrors:true});await gradeEvaluation(run,grading,{retryErrors:true});
  assert.deepEqual(await snapshot(),before);assert.equal(await readFile(targetLog,'utf8'),targetBefore);assert.equal(await readFile(judgeLog,'utf8'),judgeBefore);
});
