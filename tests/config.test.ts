import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {preparePlan,prepareGrading,getConfigSchemas} from '../src/config.js';

async function config(data:unknown){const dir=await mkdtemp(path.join(os.tmpdir(),'one-eval-config-'));const file=path.join(dir,'config.json');await writeFile(file,JSON.stringify(data));return {dir,file};}
const base={version:1,name:'test',cases:[{id:'a',input:'hello'}],target:{kind:'provider',provider:'echo',isolation:{mode:'stateless',scope:'independent',evidence:'A stateless local provider'},retrySafe:true}};
test('configuration rejects unknown fields, duplicate IDs and undeclared isolation',async()=> {
  await assert.rejects(()=>config({...base,typo:true}).then(x=>preparePlan(x.file)));
  await assert.rejects(()=>config({...base,cases:[...base.cases,...base.cases]}).then(x=>preparePlan(x.file)),/Duplicate case/);
  await assert.rejects(()=>config({...base,target:{kind:'provider',provider:'echo'}}).then(x=>preparePlan(x.file)));
});
test('JSONL is normalized with case provenance and input defaults',async()=> {
  const f=await config({...base,cases:'./cases.jsonl'});
  await writeFile(path.join(f.dir,'cases.jsonl'),JSON.stringify({id:'line-1',input:'',metadata:{sourceRow:2}})+'\n');
  const result=await preparePlan(f.file);assert.equal(result.plan.cases[0]?.input,'');assert.equal(result.plan.cases[0]?.weight,1);
  assert.equal(result.plan.cases[0]?.metadata?.sourceRow,2);assert.equal(result.files.length,2);
});
test('grader scripts are resolved and hashed relative to config',async()=> {
  const f=await config({version:1,judges:[{id:'script',kind:'command',command:'node',args:['./grade.mjs']}]});
  await writeFile(path.join(f.dir,'grade.mjs'),'console.log(1);');
  const result=await prepareGrading(f.file);assert.equal(result.plan.judges[0]?.args?.[0],path.join(f.dir,'grade.mjs'));assert.equal(result.files.length,2);
});
test('Agent-facing configuration schemas serialize without executing a provider',()=> {
  const schemas=getConfigSchemas();assert.equal(schemas.execution.type,'object');assert.equal(schemas.grading.type,'object');assert.ok(JSON.stringify(schemas).includes('isolation'));
});
