import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {withRunLock,writeArtifact,listArtifacts,writeRunState,readRunState} from '../src/storage.js';
import type {TrialArtifact} from '../src/types.js';

test('a run lease excludes a second owner and releases after errors',async()=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'one-eval-lock-'));
  await withRunLock(directory,async()=>{await assert.rejects(()=>withRunLock(directory,async()=>true),/already being held/);});
  await assert.rejects(()=>withRunLock(directory,async()=>{throw new Error('test failure');}),/test failure/);
  assert.equal(await withRunLock(directory,async()=>true),true);
});

test('partial writes are serialized, snapshot their inputs, and cannot overwrite a final artifact',async()=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'one-eval-write-'));
  const artifact:TrialArtifact={version:1,runId:'r',trialId:'t',caseId:'c',repeat:0,attempt:1,sessionId:'s',startedAt:'now',status:'running',messages:[]};
  const first=writeArtifact(directory,artifact);artifact.messages=[{role:'user',content:'next'}];
  const second=writeArtifact(directory,artifact);artifact.status='execution_error';artifact.error='timeout';
  const final=writeArtifact(directory,artifact);await Promise.all([first,second,final]);
  assert.equal((await listArtifacts(directory))[0]?.status,'execution_error');
  await assert.rejects(()=>writeArtifact(directory,{...artifact,status:'running'}),/immutable/);
});

test('later blocked state retains its operation owner after overlapping writes',async()=> {
  const directory=await mkdtemp(path.join(os.tmpdir(),'one-eval-state-'));
  const early=writeRunState(directory,{blocked:true,reason:'earlier error',updatedAt:'first'});
  const late=writeRunState(directory,{blocked:true,reason:'unsettled operation',activeProcess:process.pid,updatedAt:'second'});
  await Promise.all([early,late]);assert.equal((await readRunState(directory)).activeProcess,process.pid);
});
