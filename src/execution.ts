import { randomUUID } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { loadTarget, runConversation, InvalidSimulationError, SystemicSimulationError } from './adapters.js';
import { ENGINE_VERSION, schedule, guardLoadedSources } from './engine.js';
import { classifyError } from './diagnostics.js';
import { createAdmission, environmentFingerprint, refreshAdmission, validateAdmissionRecord, type AdmissionOptions } from './admission.js';
import { getRuntimeProvenance } from './provenance.js';
import { hash, readManifest, readRunState, writeRunState, writeJson, listArtifacts, latestArtifacts,
  writeArtifact, withRunLock, verifyFiles, snapshotSources, canonicalDirectory,
  validatePreparedPlan, readAttemptLedger, validateExecutionEvidence } from './storage.js';
import type { EvalCase, Json, PreparedPlan, RunManifest, RunSummary, TargetAdapter, TrialArtifact, TrialContext } from './types.js';

const now=()=>new Date().toISOString();
const describe=(error:unknown)=>classifyError(error,'execution').message;
class TrialTimeout extends Error {
  pending=false;
  readonly code='TIMEOUT';
  constructor(readonly operation:Promise<unknown>){super('Trial deadline exceeded; remote outcome may be unknown');}
}
const pendingOperations=new Map<string,Set<Promise<unknown>>>();
function trackPending(directory:string,error:unknown) {
  if(!(error instanceof TrialTimeout)||!error.pending)return;
  const pending=pendingOperations.get(directory)??new Set<Promise<unknown>>();
  pendingOperations.set(directory,pending);pending.add(error.operation);
  const settled=()=>{pending.delete(error.operation);if(!pending.size)pendingOperations.delete(directory);};
  void error.operation.then(settled,settled);
}
async function bounded<T>(operation:()=>Promise<T>, controller:AbortController, timeoutMs:number):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  const running=Promise.resolve().then(operation);
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new TrialTimeout(running));},timeoutMs);});
  try{return await Promise.race([running,timeout]);}
  catch(error){
    if(error instanceof TrialTimeout){
      let settled=false;
      await Promise.race([running.then(()=>{settled=true;},()=>{settled=true;}),new Promise(resolve=>setTimeout(resolve,100))]);
      error.pending=!settled;
    }
    throw error;
  }
  finally{clearTimeout(timer);}
}
async function block(directory:string,reason:string) {
  await writeRunState(directory,{blocked:true,reason,updatedAt:now(),activeProcess:pendingOperations.has(directory)?process.pid:undefined});
}
async function assertNoActiveOperation(directory:string) {
  if(pendingOperations.has(directory))throw new Error('An earlier operation is still active in this process; recovery would race with it.');
  const state=await readRunState(directory);
  if(state.activeProcess && state.activeProcess!==process.pid){
    let alive=true;try{process.kill(state.activeProcess,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
    if(alive)throw new Error(`Process ${state.activeProcess} still owns an unsettled operation. Recover there or wait until it exits.`);
  }
}
function outputHash(artifact:TrialArtifact) {
  return hash({output:artifact.output,messages:artifact.messages,metadata:artifact.metadata});
}
function validateExecutableEvidence(manifest:RunManifest,artifacts:TrialArtifact[],ledger:TrialArtifact[]) {
  const problems=validateExecutionEvidence(manifest,artifacts,ledger);
  for(const item of [...artifacts,...ledger]) {
    if(item.trialId!==hash({runId:manifest.runId,caseId:item.caseId,repeat:item.repeat}))throw new Error('Execution requires a canonical trial identity; imported output collections support grading and reports only');
    if(item.status==='completed' && (typeof item.output!=='string'||item.outputHash!==outputHash(item)))throw new Error('Completed execution output hash does not match its saved content');
    if(item.status==='completed' && (item.isolation?.ok===false||item.error!==undefined||item.cleanupError!==undefined||item.diagnostic!==undefined||item.cleanupDiagnostic!==undefined))throw new Error('Completed execution conflicts with its lifecycle evidence');
  }
  return problems;
}
export async function summarizeRun(directory:string):Promise<RunSummary> {
  const manifest=await readManifest(directory);
  validateAdmissionRecord(manifest.admission);
  const [artifacts,ledger]=await Promise.all([listArtifacts(directory),readAttemptLedger(directory)]);
  const problems=validateExecutableEvidence(manifest,artifacts,ledger);
  const retained=new Set(artifacts.map(item=>JSON.stringify([item.trialId,item.attempt])));
  const latest=latestArtifacts([...artifacts,...ledger.filter(item=>!retained.has(JSON.stringify([item.trialId,item.attempt])))]);
  const state=await readRunState(directory);
  const planned=manifest.prepared.plan.cases.length*manifest.prepared.plan.execution.repeats;
  const completed=latest.filter(item=>item.status==='completed').length;
  const failed=latest.filter(item=>item.status!=='completed'&&item.status!=='running').length;
  return {runId:manifest.runId,directory:path.resolve(directory),mode:manifest.admission?.mode??'legacy_unverified',planned,completed,failed,pending:planned-completed-failed,blocked:state.blocked||problems.length>0,reason:state.reason??problems[0],
    ...(state.limitReached?{limitReached:true,limitReason:state.limitReason}:{})};
}
async function reconcileInterrupted(directory:string,manifest:RunManifest) {
  const [artifacts,tickets]=await Promise.all([listArtifacts(directory),readAttemptLedger(directory)]);
  const problems=validateExecutableEvidence(manifest,artifacts,tickets);
  if(problems.length)await block(directory,`Execution evidence is incomplete: ${problems[0]}. Recover the environment before explicitly retrying.`);
  for(const started of tickets){
    if(!artifacts.some(item=>item.trialId===started.trialId&&item.attempt===started.attempt)){
      const missing:TrialArtifact={...started,status:'interrupted',finishedAt:now(),error:'A started attempt is missing its artifact; outcome is unknown'};
      await writeArtifact(directory,missing);artifacts.push(missing);
      await block(directory,'A started attempt has missing evidence. Recover the environment before explicitly retrying.');
    }
  }
  const running=artifacts.filter(item=>item.status==='running');
  for(const artifact of running) {
    artifact.status='interrupted';artifact.finishedAt=now();artifact.error='Process stopped before the trial lifecycle finished';
    await writeArtifact(directory,artifact);
  }
  if(running.length) await block(directory,'Interrupted attempts have an unknown environment state. Run recover before resuming.');
}
async function executeTrial(directory:string,manifest:RunManifest,adapter:TargetAdapter,item:EvalCase,repeat:number,attempt:number,
  onBlock:(reason:string)=>Promise<void>):Promise<void> {
  const trialId=hash({runId:manifest.runId,caseId:item.id,repeat});
  const controller=new AbortController();
  const workDir=path.join(directory,'work','execution',trialId,String(attempt));
  await mkdir(workDir,{recursive:true});
  const context:TrialContext={runId:manifest.runId,trialId,caseId:item.id,repeat,attempt,sessionId:randomUUID(),signal:controller.signal,workDir,baseDir:manifest.prepared.baseDir};
  const artifact:TrialArtifact={version:1,runId:manifest.runId,trialId,caseId:item.id,repeat,attempt,sessionId:context.sessionId,startedAt:now(),status:'running',messages:[]};
  await writeJson(path.join(directory,'attempts',`${hash(trialId)}-${attempt}.json`),artifact);
  await writeArtifact(directory,artifact);
  let session:Json=null, prepared=false, phase:'prepare'|'verify'|'execute'='prepare', acceptMessages=true;
  let outputCompleted=false;
  const timeoutMs=manifest.prepared.plan.execution.timeoutMs;
  try {
    await bounded(async()=> {
      session=await adapter.prepare(context);prepared=true;
      context.signal.throwIfAborted();
      phase='verify';
      const check=await adapter.verify(session,context);
      context.signal.throwIfAborted();
      if(!check || typeof check.ok!=='boolean' || typeof check.evidence!=='string' || !check.evidence.trim()) throw new Error('Isolation verification must return ok and nonempty evidence');
      artifact.isolation=check;
      if(!check.ok) throw new Error(`Isolation verification failed: ${check.evidence}`);
      await writeArtifact(directory,artifact);
      context.signal.throwIfAborted();
      phase='execute';
      const result=await runConversation(item,adapter,session,context,async (messages,metadata)=> {
        if(!acceptMessages || context.signal.aborted) return;
        artifact.messages=structuredClone(messages);
        if(metadata!==undefined)artifact.metadata=structuredClone(metadata);
        await writeArtifact(directory,artifact);
      });
      if(context.signal.aborted || !acceptMessages) return;
      artifact.output=result.output;artifact.messages=result.messages;artifact.stopReason=result.stopReason;
      artifact.metadata=result.metadata;artifact.outputHash=outputHash(artifact);outputCompleted=true;
    },controller,timeoutMs);
    artifact.status='completed';
  } catch(error) {
    trackPending(directory,error);
    const timedOut=error instanceof TrialTimeout || controller.signal.aborted;
    // phase is updated by the awaited closure; TS cannot track that assignment.
    const currentPhase:string=phase;
    artifact.status=currentPhase!=='execute'?'isolation_error':error instanceof InvalidSimulationError?'invalid_simulation':'execution_error';
    artifact.diagnostic=classifyError(error,currentPhase);
    artifact.error=artifact.diagnostic.message;
    if(timedOut || error instanceof SystemicSimulationError || currentPhase!=='execute' || ['authentication','permission_denied','configuration'].includes(artifact.diagnostic.code)) {
      await onBlock(`${artifact.status}: ${artifact.error}`);
    }
  } finally {
    acceptMessages=false;
    if(prepared && !pendingOperations.has(directory)) {
      const cleanupController=new AbortController();
      try {await bounded(()=>adapter.cleanup(session,{...context,signal:cleanupController.signal}),cleanupController,Math.min(timeoutMs,10_000));}
      catch(error) {
        trackPending(directory,error);
        artifact.cleanupDiagnostic=classifyError(error,'cleanup');
        artifact.cleanupError=artifact.cleanupDiagnostic.message;
        if(outputCompleted) artifact.status='cleanup_error';
        await onBlock(`Environment state is untrusted after cleanup failure: ${artifact.cleanupError}`);
      }
    }
    // A partial prepare must be handled by recover(), never presumed clean.
    artifact.finishedAt=now();
    if(artifact.output!==undefined) artifact.outputHash=outputHash(artifact);
    await writeArtifact(directory,artifact);
  }
}
async function executePending(directory:string,manifest:RunManifest,retryErrors:boolean):Promise<RunSummary> {
  await assertNoActiveOperation(directory);
  await verifyFiles(manifest.prepared.files);
  await reconcileInterrupted(directory,manifest);
  let state=await readRunState(directory);
  if(state.blocked) return summarizeRun(directory);
  const plan=manifest.prepared.plan;
  const allArtifacts=await listArtifacts(directory);
  const latest=latestArtifacts(allArtifacts);
  const prior=new Map(latest.map(item=>[item.trialId,item]));
  if(retryErrors && !plan.target.retrySafe && latest.some(item=>item.status!=='completed')) {
    throw new Error('Target does not declare retrySafe. Resolve the unknown business outcome and create a new run, or use a verified retry-safe adapter.');
  }
  const jobs:Array<{item:EvalCase;repeat:number;attempt:number}>=[];
  for(const item of plan.cases) for(let repeat=0;repeat<plan.execution.repeats;repeat++) {
    const previous=prior.get(hash({runId:manifest.runId,caseId:item.id,repeat}));
    if(previous?.status==='completed') continue;
    if(previous && !retryErrors) continue;
    jobs.push({item,repeat,attempt:(previous?.attempt??0)+1});
  }
  if(!jobs.length) return summarizeRun(directory);
  let attemptsUsed=allArtifacts.length;
  const maxAttempts=plan.execution.maxAttempts??Infinity;
  const markLimit=async()=> {
    state={...state,limitReached:true,limitReason:`Execution attempt limit reached (${attemptsUsed}/${maxAttempts}); retained attempts include errors and retries.`,updatedAt:now()};
    await writeRunState(directory,state);
  };
  if(attemptsUsed>=maxAttempts){await markLimit();return summarizeRun(directory);}
  if(state.limitReached){state={...state,limitReached:false,limitReason:undefined,updatedAt:now()};await writeRunState(directory,state);}
  let lastStart=0;
  let admission:Promise<unknown>=Promise.resolve();
  const admit=()=> {
    const next=admission.then(async()=> {
      if(state.blocked)return false;
      if(attemptsUsed>=maxAttempts){if(!state.limitReached)await markLimit();return false;}
      const delay=(plan.execution.minIntervalMs??0)-(Date.now()-lastStart);
      if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      if(state.blocked)return false;
      attemptsUsed++;lastStart=Date.now();return true;
    });
    admission=next;return next;
  };
  guardLoadedSources(manifest.prepared.files);
  const adapter=await loadTarget(plan.target,manifest.prepared.baseDir);
  const onBlock=async(reason:string)=> {state={...state,blocked:true,reason,updatedAt:now(),activeProcess:pendingOperations.has(directory)?process.pid:undefined};await writeRunState(directory,state);};
  try {
    await schedule(jobs,plan.execution.concurrency,async({item,repeat,attempt})=> {
      if(state.blocked) return;
      await verifyFiles(manifest.prepared.files);
      if(manifest.admission?.mode==='formal' && manifest.environmentHash!==environmentFingerprint(manifest.prepared))throw new Error('Formal execution environment changed after admission');
      if(state.blocked) return;
      if(!await admit())return;
      await executeTrial(directory,manifest,adapter,item,repeat,attempt,onBlock);
    });
  } catch(error) {await onBlock(`Orchestration stopped: ${describe(error)}`);throw error;}
  finally {if(adapter.close && !pendingOperations.has(directory)) {const controller=new AbortController();try{await bounded(()=>adapter.close!(),controller,10_000);}catch(error){trackPending(directory,error);await onBlock(`Adapter close failed: ${describe(error)}`);}}}
  return summarizeRun(directory);
}
/** Low-level compatibility API defaults to exploratory; use formal mode or runFormalEvaluation for gated admission. */
export async function runEvaluation(prepared:PreparedPlan,directory:string,options:AdmissionOptions={}):Promise<RunSummary> {
  validatePreparedPlan(prepared);
  directory=await canonicalDirectory(directory,true);
  return withRunLock(directory,async()=> {
    if(pendingOperations.has(directory))throw new Error('An earlier operation is still active in this process; recovery would race with it.');
    try {await access(path.join(directory,'manifest.json'));throw new Error('Run directory already exists; use resume or choose another output directory');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    if(hash({plan:prepared.plan,files:prepared.files})!==prepared.planHash) throw new Error('Prepared plan hash does not match its contents');
    const admission=await createAdmission('execution',prepared,options);
    await verifyFiles(prepared.files);
    await snapshotSources(directory,prepared.files);
    const manifest:RunManifest={version:1,runId:randomUUID(),createdAt:now(),prepared,engine:{name:'promptfoo',version:ENGINE_VERSION},admission,runtime:await getRuntimeProvenance(),environmentHash:environmentFingerprint(prepared)};
    await writeJson(path.join(directory,'manifest.json'),manifest);
    await writeRunState(directory,{blocked:false,updatedAt:now()});
    return executePending(directory,manifest,false);
  });
}
export async function runFormalEvaluation(prepared:PreparedPlan,directory:string,receipt:string):Promise<RunSummary> {
  return runEvaluation(prepared,directory,{mode:'formal',receipt});
}
export async function resumeEvaluation(directory:string,options:AdmissionOptions&{retryErrors?:boolean}={}):Promise<RunSummary> {
  directory=await canonicalDirectory(directory);
  return withRunLock(directory,async()=>{
    const manifest=await readManifest(directory);
    if(manifest.admission?.mode==='formal' && manifest.environmentHash!==environmentFingerprint(manifest.prepared))throw new Error('Formal execution environment differs from the original run; create a new run');
    if(manifest.admission?.mode==='formal' && (!manifest.runtime || hash(manifest.runtime)!==hash(await getRuntimeProvenance())))throw new Error('Formal execution runtime differs from the original run; create a new run');
    const admission=await refreshAdmission('execution',manifest.prepared,manifest.admission,options);
    if(admission!==manifest.admission){
      manifest.admissionHistory=[...(manifest.admissionHistory??[]),manifest.admission!];manifest.admission=admission;
      await writeJson(path.join(directory,'manifest.json'),manifest);
    }
    return executePending(directory,manifest,options.retryErrors??false);
  });
}
export async function recoverEvaluation(directory:string):Promise<RunSummary> {
  directory=await canonicalDirectory(directory);
  return withRunLock(directory,async()=> {
    const manifest=await readManifest(directory);
    validateAdmissionRecord(manifest.admission);
    // Recovery must be able to clean a blocked environment after admission expires.
    // It cannot move that recovery to another deployment binding or implementation.
    if(manifest.admission?.mode==='formal' && manifest.environmentHash!==environmentFingerprint(manifest.prepared))throw new Error('Formal recovery environment differs from the original run');
    if(manifest.admission?.mode==='formal' && (!manifest.runtime || hash(manifest.runtime)!==hash(await getRuntimeProvenance())))throw new Error('Formal recovery runtime differs from the original run');
    await assertNoActiveOperation(directory);
    await verifyFiles(manifest.prepared.files);
    await reconcileInterrupted(directory,manifest);
    if(!(await readRunState(directory)).blocked) return summarizeRun(directory);
    guardLoadedSources(manifest.prepared.files);
    const adapter=await loadTarget(manifest.prepared.plan.target,manifest.prepared.baseDir);
    let closeAttempted=false;
    try {
      if(!adapter.recover) throw new Error('This adapter has no recovery operation. Provide verified environment recovery before resuming.');
      const controller=new AbortController();
      const check=await bounded(()=>adapter.recover!({runId:manifest.runId,workDir:path.join(directory,'work','recovery'),signal:controller.signal}),controller,manifest.prepared.plan.execution.timeoutMs);
      if(!check?.ok || typeof check.evidence!=='string' || !check.evidence.trim()) throw new Error('Recovery did not provide successful isolation evidence');
      if(adapter.close){closeAttempted=true;await bounded(()=>adapter.close!(),new AbortController(),10_000);}
      await writeJson(path.join(directory,'recovery',`${randomUUID()}.json`),{at:now(),check});
      await writeRunState(directory,{blocked:false,updatedAt:now()});
    } catch(error){trackPending(directory,error);await block(directory,`Recovery failed: ${describe(error)}`);throw error;}
    finally {if(!closeAttempted && adapter.close && !pendingOperations.has(directory)){try{await bounded(()=>adapter.close!(),new AbortController(),10_000);}catch(error){trackPending(directory,error);await block(directory,`Recovery close failed: ${describe(error)}`);throw error;}}}
    return summarizeRun(directory);
  });
}
