import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePlan } from '../src/config.js';
import { runEvaluation, resumeEvaluation, recoverEvaluation } from '../src/execution.js';
import { hash, listArtifacts, latestArtifacts, readManifest, readRunState, writeJson } from '../src/storage.js';

async function fixture(options:Record<string,unknown>={},execution:Record<string,unknown>={},cases:unknown[]=[{id:'a',input:'first'},{id:'b',input:'second'}]) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'one-eval-execution-'));
  const modulePath=path.join(directory,'adapter.mjs');
  await copyFile(path.resolve('tests/fixtures/lifecycle.mjs'),modulePath);
  const log=path.join(directory,'calls.jsonl');
  const config=path.join(directory,'eval.json');
  await writeFile(config,JSON.stringify({version:1,name:'test',cases,target:{kind:'module',path:modulePath,config:{log,...options},isolation:{mode:'managed',scope:'shared',evidence:'Local test state'},retrySafe:true},execution:{repeats:1,concurrency:1,timeoutMs:3000,...execution}}));
  return {directory,config,modulePath,log,run:path.join(directory,'run'),readLog:async()=> (await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line))};
}

test('repeated cases have fresh sessions; completed attempts are skipped on resume',async()=> {
  const f=await fixture({}, {repeats:3});
  const result=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(result.completed,6);assert.equal(result.blocked,false);
  const calls=(await f.readLog()).filter(x=>x.event==='execute');
  assert.equal(calls.length,6);assert.equal(new Set(calls.map(x=>x.sessionId)).size,6);
  const artifacts=await listArtifacts(f.run);
  assert.ok(artifacts.every(x=>x.output?.endsWith(':1')));
  await resumeEvaluation(f.run,{retryErrors:true});
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,6);
});

test('an execution attempt cap survives resume and cannot be exceeded by concurrent workers',async()=> {
  const f=await fixture({}, {repeats:3,concurrency:4,maxAttempts:2});
  const config=JSON.parse(await readFile(f.config,'utf8'));config.target.isolation.scope='independent';
  await writeFile(f.config,JSON.stringify(config));
  const first=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(first.completed,2);assert.equal(first.pending,4);assert.equal(first.limitReached,true);assert.equal(first.blocked,false);
  const before=await listArtifacts(f.run);
  const resumed=await resumeEvaluation(f.run,{retryErrors:true});
  assert.equal(resumed.limitReached,true);assert.deepEqual(await listArtifacts(f.run),before);
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,2);
});

test('failed attempts consume the execution cap and expose structured diagnostics',async()=> {
  const f=await fixture({errorCase:'a'}, {maxAttempts:2});
  const first=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(first.failed,1);assert.equal(first.completed,1);
  const failed=(await listArtifacts(f.run)).find(item=>item.status==='execution_error')!;
  assert.equal(failed.diagnostic?.phase,'execute');assert.match(failed.diagnostic!.message,/Deliberate target failure/);
  const resumed=await resumeEvaluation(f.run,{retryErrors:true});
  assert.equal(resumed.failed,1);assert.equal(resumed.limitReached,true);assert.equal((await listArtifacts(f.run)).length,2);
});

test('wrapped authentication causes block execution before later cases',async()=> {
  const f=await fixture({errorCase:'a'});
  await writeFile(f.modulePath,(await readFile(f.modulePath,'utf8')).replace("throw new Error('Deliberate target failure')","throw new Error('Provider request failed',{cause:Object.assign(new Error('Access rejected'),{status:401})})"));
  const result=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(result.blocked,true);assert.equal(result.pending,1);
  assert.equal((await listArtifacts(f.run))[0]?.diagnostic?.code,'authentication');
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,1);
});

test('execution start spacing applies across concurrent trial workers',async()=> {
  const f=await fixture({}, {concurrency:2,minIntervalMs:160});
  const config=JSON.parse(await readFile(f.config,'utf8'));config.target.isolation.scope='independent';
  await writeFile(f.config,JSON.stringify(config));
  const result=await runEvaluation(await preparePlan(f.config),f.run);assert.equal(result.completed,2);
  const starts=(await listArtifacts(f.run)).map(item=>Date.parse(item.startedAt)).sort((a,b)=>a-b);
  assert.ok(starts[1]!-starts[0]!>=120,`Starts were only ${starts[1]!-starts[0]!} ms apart`);
});

test('isolation verification failure blocks all target calls',async()=> {
  const f=await fixture({verify:false});
  const result=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(result.blocked,true);assert.equal(result.failed,1);assert.equal(result.pending,1);
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,0);
  assert.equal((await listArtifacts(f.run))[0]?.status,'isolation_error');
});

test('cleanup failure preserves output, pauses the environment, and requires recovery',async()=> {
  const control=path.join(await mkdtemp(path.join(os.tmpdir(),'one-eval-control-')),'state');await writeFile(control,'fail');
  const f=await fixture({cleanupControl:control});
  const result=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(result.blocked,true);assert.equal(result.pending,1);
  const artifacts=await listArtifacts(f.run);
  assert.equal(artifacts[0]?.status,'cleanup_error');assert.equal(artifacts[0]?.output,'a:1');
  await resumeEvaluation(f.run,{retryErrors:true});assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,1);
  await recoverEvaluation(f.run);
  const resumed=await resumeEvaluation(f.run,{retryErrors:true});assert.equal(resumed.completed,2);assert.equal(resumed.blocked,false);
  assert.equal((await listArtifacts(f.run)).length,3);
});

test('ordinary execution errors continue; explicit retry adds an attempt without rerunning successes',async()=> {
  const f=await fixture({errorCase:'a'});
  const first=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(first.completed,1);assert.equal(first.failed,1);assert.equal(first.blocked,false);
  await resumeEvaluation(f.run);assert.equal((await listArtifacts(f.run)).length,2);
  const second=await resumeEvaluation(f.run,{retryErrors:true});assert.equal(second.completed,2);
  const artifacts=await listArtifacts(f.run);
  assert.equal(artifacts.filter(x=>x.caseId==='b').length,1);assert.equal(artifacts.filter(x=>x.caseId==='a').length,2);
});

test('partial multi-turn traces survive a later target failure',async()=> {
  const f=await fixture({failTurn:2},{},[{id:'a',input:'first',conversation:{mode:'scripted',turns:['second']}}]);
  await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  assert.equal(artifact.status,'execution_error');assert.equal(artifact.messages.length,3);
  assert.equal(artifact.messages[1]?.content,'a:1');assert.equal(artifact.messages[2]?.content,'second');
});

test('timeouts block later calls and ignore late completions',async()=> {
  const f=await fixture({delayMs:120},{timeoutMs:40});
  const result=await runEvaluation(await preparePlan(f.config),f.run);
  assert.equal(result.blocked,true);assert.equal(result.pending,1);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal((await listArtifacts(f.run))[0]?.status,'execution_error');
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,1);
});

test('changing source code prevents resume before any new execution',async()=> {
  const f=await fixture({errorCase:'a'});
  await runEvaluation(await preparePlan(f.config),f.run);
  await writeFile(f.modulePath,'throw new Error("modified")');
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/Source changed/);
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,2);
});

test('a previously running attempt is recorded as interrupted and requires recovery',async()=> {
  const f=await fixture();
  await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  await writeJson(path.join(f.run,'artifacts',`${hash(artifact.trialId)}-${artifact.attempt}.json`),{...artifact,status:'running'});
  const result=await resumeEvaluation(f.run);
  assert.equal(result.blocked,true);
  assert.equal(latestArtifacts(await listArtifacts(f.run)).filter(x=>x.status==='interrupted').length,1);
});

test('shared state rejects concurrent execution in the plan',async()=> {
  const f=await fixture({}, {concurrency:2});
  await assert.rejects(()=>preparePlan(f.config),/Shared environments/);
});

test('empty output is a completed artifact with a verifiable hash',async()=> {
  const f=await fixture({empty:true});
  await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  assert.equal(artifact.output,'');assert.equal(artifact.status,'completed');
  assert.equal(artifact.outputHash,hash({output:'',messages:artifact.messages,metadata:artifact.metadata}));
  const manifest=await readManifest(f.run);assert.equal(manifest.engine.name,'promptfoo');
});

test('lost artifacts cannot make resume repeat previously started business operations',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  await unlink(path.join(f.run,'artifacts',`${hash(artifact.trialId)}-${artifact.attempt}.json`));
  const result=await resumeEvaluation(f.run);assert.equal(result.blocked,true);
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,2);
  assert.equal((await listArtifacts(f.run)).filter(x=>x.status==='interrupted').length,1);
});

test('non-idempotent cleanup failures cannot be retried after recovery',async()=> {
  const control=path.join(await mkdtemp(path.join(os.tmpdir(),'one-eval-control-')),'state');await writeFile(control,'fail');
  const f=await fixture({cleanupControl:control});
  const config=JSON.parse(await readFile(f.config,'utf8'));config.target.retrySafe=false;await writeFile(f.config,JSON.stringify(config));
  await runEvaluation(await preparePlan(f.config),f.run);await recoverEvaluation(f.run);
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/retrySafe/);
  assert.equal((await f.readLog()).filter(x=>x.event==='execute').length,1);
});

test('failed recovery close keeps the environment blocked',async()=> {
  const control=path.join(await mkdtemp(path.join(os.tmpdir(),'one-eval-close-')),'state');await writeFile(control,'fail');
  const f=await fixture({closeControl:control});await runEvaluation(await preparePlan(f.config),f.run);
  await assert.rejects(()=>recoverEvaluation(f.run),/close failure/);
  assert.equal((await readRunState(f.run)).blocked,true);
});

test('unsettled target cancellation blocks cleanup and recovery in the owning process',async()=> {
  const f=await fixture({delayMs:600},{timeoutMs:40});
  const result=await runEvaluation(await preparePlan(f.config),f.run);assert.equal(result.blocked,true);
  assert.equal((await readRunState(f.run)).activeProcess,process.pid);
  assert.equal((await f.readLog()).filter(x=>x.event==='cleanup').length,0);
  await assert.rejects(()=>recoverEvaluation(f.run),/still active/);
  if(process.platform==='win32')await assert.rejects(()=>recoverEvaluation(f.run.toUpperCase()),/still active/);
  await new Promise(resolve=>setTimeout(resolve,650));
  await recoverEvaluation(f.run);assert.equal((await readRunState(f.run)).blocked,false);
});

test('a same-process source change is rejected before a new run can use cached imports',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  await writeFile(f.modulePath,(await readFile(f.modulePath,'utf8'))+'\n// changed version\n');
  await assert.rejects(async()=>runEvaluation(await preparePlan(f.config),path.join(f.directory,'second-run')),/fresh process/);
});

test('adversarial: direct execution rejects a rehashed invalid plan before target calls',async()=> {
  const f=await fixture();const prepared=await preparePlan(f.config);
  prepared.plan.cases[0]!.weight=0;
  prepared.planHash=hash({plan:prepared.plan,files:prepared.files});
  await assert.rejects(()=>runEvaluation(prepared,f.run),/Invalid.*case\/weight/);
  await assert.rejects(()=>readFile(f.log),{code:'ENOENT'});
});

test('adversarial: resume rejects a foreign artifact before modifying evidence or making calls',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  const file=path.join(f.run,'artifacts',`${hash(artifact.trialId)}-${artifact.attempt}.json`);
  await writeJson(file,{...artifact,runId:'foreign-run'});
  const before=await readFile(file,'utf8');const calls=await f.readLog();
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/does not belong/);
  assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(await f.readLog(),calls);
});

test('adversarial: resume and recovery reject mismatched reservations without side effects',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  const file=path.join(f.run,'attempts',`${hash(artifact.trialId)}-${artifact.attempt}.json`);
  const ticket=JSON.parse(await readFile(file,'utf8'));
  await writeJson(file,{...ticket,sessionId:'foreign-session'});
  const before=await listArtifacts(f.run);const calls=await f.readLog();
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/identity.*ledger/);
  await assert.rejects(()=>recoverEvaluation(f.run),/identity.*ledger/);
  assert.deepEqual(await listArtifacts(f.run),before);assert.deepEqual(await f.readLog(),calls);
});

test('adversarial: consistently renamed trial evidence cannot trigger a duplicate business operation',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  const oldName=`${hash(artifact.trialId)}-${artifact.attempt}.json`;
  const foreignTrial='renamed-imported-trial';const newName=`${hash(foreignTrial)}-${artifact.attempt}.json`;
  for(const folder of ['artifacts','attempts']) {
    const oldFile=path.join(f.run,folder,oldName);
    const saved=JSON.parse(await readFile(oldFile,'utf8'));
    await writeJson(path.join(f.run,folder,newName),{...saved,trialId:foreignTrial});await unlink(oldFile);
  }
  const calls=await f.readLog();const before=await listArtifacts(f.run);
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/canonical trial identity|conflicting trial identities/);
  assert.deepEqual(await f.readLog(),calls);
  await assert.rejects(()=>recoverEvaluation(f.run),/canonical trial identity/);
  assert.deepEqual(await f.readLog(),calls);assert.deepEqual(await listArtifacts(f.run),before);
});

test('adversarial: tampered completed output is rejected before resume or recovery',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  const file=path.join(f.run,'artifacts',`${hash(artifact.trialId)}-${artifact.attempt}.json`);
  await writeJson(file,{...artifact,output:'changed without updating the saved digest'});
  const before=await readFile(file,'utf8');const calls=await f.readLog();
  await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/output hash/);
  await assert.rejects(()=>recoverEvaluation(f.run),/output hash/);
  assert.equal(await readFile(file,'utf8'),before);assert.deepEqual(await f.readLog(),calls);
});

test('adversarial: a completed label cannot override failed isolation or lifecycle errors',async()=> {
  const f=await fixture();await runEvaluation(await preparePlan(f.config),f.run);
  const artifact=(await listArtifacts(f.run))[0]!;
  const file=path.join(f.run,'artifacts',`${hash(artifact.trialId)}-${artifact.attempt}.json`);
  const calls=await f.readLog();
  for(const changes of [{isolation:{ok:false,evidence:'Verification failed'}},{cleanupError:'Cleanup failed'},{error:'Target failed'},
    {diagnostic:{code:'timeout',phase:'execute',message:'Target timed out',retryable:false}},
    {cleanupDiagnostic:{code:'cleanup_failed',phase:'cleanup',message:'Cleanup failed',retryable:false}}]) {
    await writeJson(file,{...artifact,...changes});
    await assert.rejects(()=>resumeEvaluation(f.run,{retryErrors:true}),/lifecycle evidence/);
    assert.deepEqual(await f.readLog(),calls);
  }
});
