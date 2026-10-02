import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preparePlan } from '../src/config.js';
import { runEvaluation } from '../src/execution.js';
import { listArtifacts } from '../src/storage.js';

async function service(handler:(body:any)=>{status?:number;body:unknown}) {
  const server=http.createServer(async(req,res)=> {
    let input='';for await(const chunk of req) input+=chunk;
    try {
      const result=handler(JSON.parse(input||'{}'));
      res.writeHead(result.status??200,{'content-type':'application/json'});res.end(JSON.stringify(result.body));
    } catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  return {url:`http://127.0.0.1:${address.port}`,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}

test('real HTTP provider repeats requests without serving previous outputs from cache',async()=> {
  let requests=0;
  const server=await service(()=>({body:{output:`response-${++requests}`}}));
  try {
    const dir=await mkdtemp(path.join(os.tmpdir(),'one-eval-http-'));
    const file=path.join(dir,'eval.json');
    await writeFile(file,JSON.stringify({version:1,name:'HTTP smoke',cases:[{id:'a',input:'identical input'}],
      target:{kind:'provider',provider:{id:server.url,config:{method:'POST',headers:{'Content-Type':'application/json'},body:{prompt:'{{prompt}}'},responseParser:'json.output'}},isolation:{mode:'stateless',scope:'independent',evidence:'Local HTTP fixture has no session memory'},retrySafe:true},execution:{repeats:3,concurrency:1,timeoutMs:5000}}));
    const result=await runEvaluation(await preparePlan(file),path.join(dir,'run'));
    assert.equal(result.completed,3);assert.equal(requests,3);
    assert.equal(new Set((await listArtifacts(path.join(dir,'run'))).map(item=>item.output)).size,3);
  } finally {await server.close();}
});

test('HTTP 429 is recorded once without a hidden SDK retry',async()=> {
  let requests=0;
  const server=await service(()=>{requests++;return {status:429,body:{error:'rate limited'}};});
  try {
    const dir=await mkdtemp(path.join(os.tmpdir(),'one-eval-http-error-'));
    const file=path.join(dir,'eval.json');
    await writeFile(file,JSON.stringify({version:1,name:'HTTP retry contract',cases:[{id:'a',input:'write-like request'}],
      target:{kind:'provider',provider:{id:server.url,config:{method:'POST',body:{prompt:'{{prompt}}'},responseParser:'json.output'}},isolation:{mode:'stateless',scope:'independent',evidence:'Local fixture'},retrySafe:false},execution:{timeoutMs:2000}}));
    const result=await runEvaluation(await preparePlan(file),path.join(dir,'run'));
    assert.equal(result.failed,1);assert.equal(requests,1);
  } finally {await server.close();}
});

test('a stateful HTTP application starts each trial from verified initial business state',async()=> {
  const sessions=new Map<string,{turns:number;state:string}>();
  const starts:string[]=[];let targetCalls=0;
  const server=await service(body=> {
    const id=body.sessionId;
    if(body.action==='prepare'){sessions.set(id,{turns:0,state:'paid'});starts.push(id);return {body:{sessionId:id}};}
    const session=sessions.get(id);
    if(!session) return {status:404,body:{error:'session missing'}};
    if(body.action==='verify') return {body:{ok:session.turns===0&&session.state==='paid',evidence:'Read fresh paid order from HTTP application'}};
    if(body.action==='execute'){session.turns++;session.state='refunded';targetCalls++;return {body:{output:`${session.state}:${session.turns}`}};}
    sessions.delete(id);return {body:{ok:true}};
  });
  try {
    const dir=await mkdtemp(path.join(os.tmpdir(),'one-eval-http-state-'));
    await writeFile(path.join(dir,'adapter.mjs'),`export function createTarget(config) {
      const request=async(action,context)=>{const r=await fetch(config.url,{method:'POST',signal:context.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action,sessionId:context.sessionId})});if(!r.ok)throw new Error('HTTP '+r.status);return r.json();};
      return {prepare:c=>request('prepare',c),verify:(s,c)=>request('verify',c),execute:(m,s,c)=>request('execute',c),cleanup:(s,c)=>request('cleanup',c)};
    }`);
    const file=path.join(dir,'eval.json');
    await writeFile(file,JSON.stringify({version:1,name:'Stateful HTTP trial',cases:[{id:'a',input:'refund'},{id:'b',input:'refund'}],target:{kind:'module',path:'./adapter.mjs',config:{url:server.url},isolation:{mode:'managed',scope:'independent',evidence:'Independent server sessions with order reset verification'},retrySafe:true},execution:{repeats:3,concurrency:3,timeoutMs:5000}}));
    const result=await runEvaluation(await preparePlan(file),path.join(dir,'run'));
    assert.equal(result.completed,6);assert.equal(targetCalls,6);assert.equal(new Set(starts).size,6);assert.equal(sessions.size,0);
    assert.ok((await listArtifacts(path.join(dir,'run'))).every(item=>item.output==='refunded:1'&&item.isolation?.ok));
  } finally {await server.close();}
});
