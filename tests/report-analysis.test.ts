import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePlan, prepareGrading } from '../src/config.js';
import { runEvaluation } from '../src/execution.js';
import { gradeEvaluation } from '../src/grading.js';
import { buildReport } from '../src/report.js';
import { compareRuns } from '../src/compare.js';
import { analyzeReport } from '../src/report-analysis.js';
import type { TrialArtifact } from '../src/types.js';

test('groups retain missing scores and overlapping tags cannot reweight the overall score',()=> {
  const cases=[
    {caseId:'a',weight:1,metadata:{category:'math',tags:['small','small']},complete:true,score:1,executions:[{complete:true,score:1,judges:[{judgeId:'j1',score:1},{judgeId:'j2',score:0}]}]},
    {caseId:'b',weight:3,metadata:{category:'math',tags:['large']},complete:false,score:null,executions:[{complete:false,score:null,judges:[{judgeId:'j1',score:1},{judgeId:'j2',score:null}]}]},
  ];
  const analysis=analyzeReport(cases,[],[],2,false);
  assert.equal(analysis.groups.find(group=>group.kind==='category')?.score,null);
  assert.equal(analysis.groups.find(group=>group.label==='small')?.cases,1);
  assert.equal(analysis.groups.find(group=>group.label==='small')?.score,1);
  assert.equal(analysis.stability.judgeDisagreements.length,1);
  assert.equal(analysis.stability.judgeDisagreements[0]?.range,1);
  assert.equal(analysis.usage.target.cost.knownTotal,null);
});

test('one metered turn does not hide unmetered turns or attempts without call evidence',()=> {
  const base:TrialArtifact={version:1,runId:'r',trialId:'a',caseId:'a',repeat:0,attempt:1,sessionId:'s',startedAt:'2026-10-02T00:00:00Z',status:'completed',messages:[],output:''};
  const observed:TrialArtifact={...base,metadata:{target:{cost:0.1,calls:[{cost:0.1,tokenUsage:{input:10}},{tokenUsage:{output:5}}]}}};
  const failed={...base,trialId:'b',caseId:'b',status:'execution_error' as const,error:'Request failed before response'};
  const usage=analyzeReport([], [observed,failed], [],2,false).usage.target;
  assert.equal(usage.cost.knownTotal,0.1);assert.equal(usage.cost.knownRecords,1);assert.equal(usage.cost.unknownRecords,2);
  assert.equal(usage.attemptsWithoutCallEvidence,1);assert.equal(usage.tokens.input?.knownRecords,1);
});

test('report and comparison retain weighted scores, diagnostic history and compatibility boundaries',async()=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'one-eval-compare-'));
  const target=path.join(directory,'target.mjs');
  await writeFile(target,`export function createTarget(config){return {
    async prepare(c){return c.sessionId},async verify(){return {ok:true,evidence:'Disposable local target'}},
    async execute(messages,session,context){return {output:context.caseId===config.correct?'correct':'wrong',cost:0.02,tokenUsage:{input:10,cached:4,output:2}}},async cleanup(){}
  }};`);
  const script=path.join(directory,'grade.mjs');
  await writeFile(script,`import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({status:'scored',score:input.artifact.output==='correct'?1:0,reason:'Fixed binary rubric'}));`);
  const judgeFile=path.join(directory,'judges.json');
  await writeFile(judgeFile,JSON.stringify({version:1,judges:[{id:'binary',kind:'command',command:process.execPath,args:[script]}]}));
  const grading=await prepareGrading(judgeFile);
  const cases=[{id:'a',input:'A',weight:1,metadata:{category:'one'}},{id:'b',input:'B',weight:3,metadata:{category:'two'}}];
  async function run(name:string,correct:string,changed=false,metadataChanged=false){
    const config=path.join(directory,`${name}.json`);
    await writeFile(config,JSON.stringify({version:1,name,cases:changed?[{...cases[0],input:'changed'},cases[1]]:metadataChanged?[{...cases[0],metadata:{category:'one',expectedState:'different'}},cases[1]]:cases,
      target:{kind:'module',path:target,config:{correct},isolation:{mode:'managed',scope:'independent',evidence:'Independent in-memory target'},retrySafe:true}}));
    const out=path.join(directory,name);await runEvaluation(await preparePlan(config),out);await gradeEvaluation(out,grading);return out;
  }
  const baseline=await run('baseline','b');const candidate=await run('candidate','a');
  const report=await buildReport(baseline);
  assert.equal(report.overall,0.75);assert.equal(report.analysis.groups.find(group=>group.label==='two')?.score,1);
  assert.equal(report.analysis.reliability.firstAttemptCompletionRate,1);
  assert.equal(report.analysis.usage.target.cost.knownTotal,0.04);
  assert.equal(report.analysis.usage.target.tokens.input?.knownTotal,20);
  assert.equal(report.analysis.usage.grading.cost.knownTotal,null);
  assert.equal(report.analysis.usage.grading.cost.unknownRecords,2);
  const comparison=await compareRuns(baseline,candidate);
  assert.equal(comparison.comparable,true);assert.equal(comparison.delta,-0.5);
  assert.equal(comparison.improvements,1);assert.equal(comparison.regressions,1);
  const same=await compareRuns(baseline,baseline);assert.equal(same.delta,0);
  const changed=await run('changed','a',true);const mismatch=await compareRuns(baseline,changed);
  assert.equal(mismatch.comparable,false);assert.equal(mismatch.delta,null);assert.deepEqual(mismatch.checks.changed,['a']);
  const changedMetadata=await run('metadata-changed','a',false,true);
  const metadataMismatch=await compareRuns(baseline,changedMetadata);
  assert.equal(metadataMismatch.comparable,false);assert.equal(metadataMismatch.delta,null);assert.deepEqual(metadataMismatch.checks.changed,['a']);
});
