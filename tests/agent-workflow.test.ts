import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/benchmarks/agent-workflow');
const { initialState, applyTool, TOOL_NAMES } = await import(pathToFileURL(path.join(folder, 'fixture.mjs')).href);
const { createTarget } = await import(pathToFileURL(path.join(folder, 'target.mjs')).href);

async function temporary(t: any) {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-workflow-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('one-eval-workflow-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function client(directory: string) {
  const child = spawn(process.execPath, [path.join(folder, 'server.mjs'), path.join(directory, 'orders.json'), path.join(directory, 'audit.jsonl'), '1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; let next = 0; let stderr = '';
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const callbacks = pending.get(response.id); pending.delete(response.id);
      if (response.error) callbacks?.reject(new Error(JSON.stringify(response.error)));
      else callbacks?.resolve(response.result);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('exit', (code) => { for (const callback of pending.values()) callback.reject(new Error(`MCP exited ${code}: ${stderr}`)); pending.clear(); });
  function request(method: string, params: any = {}) {
    const id = ++next;
    return new Promise<any>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  try {
    await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'one-eval-test', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  } catch (error) { child.kill(); throw error; }
  return { request, close: () => new Promise<void>((resolve) => { child.once('close', () => resolve()); child.stdin.end(); }) };
}

test('real MCP stdio server changes only allowed order state and persists a complete audit', { timeout: 15000 }, async (t) => {
  const directory = await temporary(t);
  await writeFile(path.join(directory, 'orders.json'), JSON.stringify(initialState()));
  await writeFile(path.join(directory, 'audit.jsonl'), '');
  const mcp = await client(directory);
  try {
    const tools = await mcp.request('tools/list');
    assert.deepEqual(tools.tools.map((tool: any) => tool.name).sort(), [...TOOL_NAMES].sort());
    const call = async (name: string, args: any) => (await mcp.request('tools/call', { name, arguments: args })).structuredContent;
    assert.equal((await call('get_order', { order_id: 'ORD-100' })).order.status, 'paid');
    assert.equal((await call('refund_order', { order_id: 'ORD-100', reason: 'Changed my mind' })).order.refundCount, 1);
    assert.equal((await call('refund_order', { order_id: 'ORD-100', reason: 'again' })).code, 'already_refunded');
    for (const id of ['ORD-105', 'ORD-106']) assert.equal((await call('refund_order', { order_id: id, reason: 'return' })).code, 'invalid_status');
    assert.equal((await call('refund_order', { order_id: 'ORD-102', reason: 'return' })).code, 'not_eligible');
    assert.equal((await call('get_refund_status', { order_id: 'ORD-100' })).refundId, 'RF-ORD-100');
    assert.equal((await call('get_order', { order_id: '../../secret' })).code, 'not_found');
    const invalid = await mcp.request('tools/call', { name: 'get_order', arguments: { order_id: 'ORD-100', arbitrary_path: 'secret' } });
    assert.equal(invalid.isError, true);
  } finally { await mcp.close(); }
  const state = JSON.parse(await readFile(path.join(directory, 'orders.json'), 'utf8'));
  assert.equal(state.orders['ORD-100'].status, 'refunded');
  assert.equal(state.orders['ORD-100'].refundCount, 1);
  assert.equal(state.orders['ORD-105'].status, 'unpaid');
  assert.equal(state.orders['ORD-106'].status, 'shipped');
  const audit = (await readFile(path.join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.length, 8);
  assert.ok(audit.every((item, index) => item.sequence === index + 1 && item.args && item.result));
});

test('fixture instances are independent and refunds are idempotent', () => {
  const first = initialState(), second = initialState();
  applyTool(first, 'refund_order', { order_id: 'ORD-104', reason: 'return' });
  applyTool(first, 'refund_order', { order_id: 'ORD-104', reason: 'again' });
  assert.equal(first.orders['ORD-104'].refundCount, 1);
  assert.equal(second.orders['ORD-104'].status, 'paid');
});

test('replay target keeps only the trial transcript and exposes per-turn state snapshots', { timeout: 15000 }, async (t) => {
  const directory = await temporary(t);
  const mockPath = path.join(directory, 'mock.mjs');
  await writeFile(mockPath, `
if (process.argv.includes('--version')) { console.log('codex-cli 0.144.6'); process.exit(); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const lines = [
 {type:'thread.started',thread_id:'thread-'+process.pid}, {type:'turn.started'},
 {type:'item.completed',item:{type:'agent_message',text:prompt.includes('second message')?'second reply':'first reply'}},
 {type:'turn.completed',usage:{input_tokens:10,output_tokens:3}}];
for (const line of lines) console.log(JSON.stringify(line));
`);
  const invocations: any[] = [];
  const spawnProcess = (_binary: string, args: string[], options: any) => {
    invocations.push({ args, options });
    return spawn(process.execPath, [mockPath, ...args], options);
  };
  const adapter = await createTarget({ binaryPath: process.execPath, enableTools: false, instructions: 'Remember only this conversation.' }, { spawnProcess });
  t.after(() => adapter.close());
  const context = { sessionId: 'unique-session', signal: new AbortController().signal };
  const session = await adapter.prepare(context);
  assert.equal((await adapter.verify(session, context)).ok, true);
  const first = await adapter.execute([{ role: 'user', content: 'first message' }], session, context);
  const second = await adapter.execute([{ role: 'user', content: 'first message' }, { role: 'assistant', content: first.output }, { role: 'user', content: 'second message' }], session, context);
  assert.notEqual(first.metadata.threadId, second.metadata.threadId);
  assert.equal(second.metadata.turn, 2);
  assert.equal(second.metadata.conversationStrategy, 'transcript-replay');
  assert.deepEqual(second.metadata.toolAudit, []);
  assert.deepEqual(second.metadata.finalState, initialState());
  assert.ok(invocations.slice(1).every(call => call.args.includes('mcp_servers={}')));
  await assert.rejects(adapter.execute([{ role: 'user', content: 'other trial message' }], session, context), /only this trial transcript/);
  await adapter.cleanup(session, context);
  await assert.rejects(access(session.directory), { code: 'ENOENT' });
});

test('MCP evidence must match current-turn tool arguments and results one-to-one', { timeout: 15000 }, async (t) => {
  const directory = await temporary(t);
  const mockPath = path.join(directory, 'mock-evidence.mjs');
  await writeFile(mockPath, `
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) {console.log('codex-cli 0.144.6');process.exit();}
let prompt=''; for await (const chunk of process.stdin) prompt+=chunk;
const result={ok:true,order:JSON.parse(await readFile('orders.json','utf8')).orders['ORD-100']};
const audit={sequence:1,turn:1,tool:'get_order',args:{order_id:'ORD-100'},result};
await writeFile('audit.jsonl',JSON.stringify(audit)+'\\n');
const args={order_id:prompt.includes('mismatch')?'ORD-101':'ORD-100'};
for(const event of [{type:'thread.started',thread_id:'thread-'+process.pid},{type:'turn.started'},
{type:'item.completed',item:{type:'mcp_tool_call',server:'orders',tool:'get_order',arguments:args,result:{structured_content:result},status:'completed'}},
{type:'item.completed',item:{type:'agent_message',text:'done'}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(event));
`);
  const adapter = await createTarget({ binaryPath: process.execPath }, {
    spawnProcess: (_binary: string, args: string[], options: any) => spawn(process.execPath, [mockPath, ...args], options),
  });
  t.after(() => adapter.close());
  for (const content of ['valid', 'mismatch']) {
    const context = { sessionId: content, signal: new AbortController().signal };
    const session = await adapter.prepare(context);
    const operation = adapter.execute([{ role: 'user', content }], session, context);
    if (content === 'valid') assert.equal((await operation).metadata.toolAudit.length, 1);
    else await assert.rejects(operation, /arguments or results do not match one-to-one/);
    await adapter.cleanup(session, context);
  }
});

test('abort terminates the Codex process tree including its real MCP server child', { timeout: 15000 }, async (t) => {
  const directory = await temporary(t);
  const mockPath = path.join(directory, 'mock-tree.mjs');
  await writeFile(mockPath, `
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--version')) {console.log('codex-cli 0.144.6');process.exit();}
const child=spawn(process.execPath,[${JSON.stringify(path.join(folder, 'server.mjs'))},path.resolve('orders.json'),path.resolve('audit.jsonl'),'1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
child.stdout.on('data',async()=>{await writeFile('child.json',JSON.stringify({parent:process.pid,child:child.pid}));});
child.stderr.resume();
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'abort-test',version:'1'}}})+'\\n');
setInterval(()=>{},1000);
`);
  const adapter = await createTarget({ binaryPath: process.execPath }, {
    spawnProcess: (_binary: string, args: string[], options: any) => spawn(process.execPath, [mockPath, ...args], options),
  });
  t.after(() => adapter.close());
  const controller = new AbortController();
  const context = { sessionId: 'abort-tree', signal: controller.signal };
  const session = await adapter.prepare(context);
  const operation = adapter.execute([{ role: 'user', content: 'wait' }], session, context);
  const rejected = assert.rejects(operation, /trial aborted/);
  let pids: { parent: number; child: number } | undefined;
  for (let attempt = 0; attempt < 100 && !pids; attempt++) {
    try { pids = JSON.parse(await readFile(path.join(session.directory, 'child.json'), 'utf8')); }
    catch { await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  assert.ok(pids, 'real MCP child completed initialization before cancellation');
  controller.abort();
  await rejected;
  for (const pid of [pids.parent, pids.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await adapter.cleanup(session, context);
  await assert.rejects(access(session.directory), { code: 'ENOENT' });
});
