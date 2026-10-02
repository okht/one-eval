import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyError } from '../src/diagnostics.js';
import { InvalidSimulationError, SystemicSimulationError, loadTarget, runConversation } from '../src/adapters.js';
import type { EvalCase, Json, JsonObject, Message, TargetAdapter, TargetConfig, TargetReply, TrialContext } from '../src/types.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const providerPath = `file://${join(fixtures, 'adapters-provider.mjs')}`;

function context(id = 'trial-1', signal = new AbortController().signal): TrialContext {
  return {
    runId: 'run-1', trialId: id, caseId: 'case-1', repeat: 0, attempt: 0,
    sessionId: `session-${id}`, signal, workDir: fixtures,
  };
}

function adapter(execute: TargetAdapter['execute']): TargetAdapter {
  return {
    async prepare() { return {}; },
    async verify() { return { ok: true, evidence: 'test fixture' }; },
    execute,
    async cleanup() {},
  };
}

function simulated(responses: Json[], maxTurns = 4): EvalCase {
  return {
    id: 'case-1', input: 'I want a refund.', reference: 'secret reference', weight: 1,
    conversation: {
      mode: 'simulated', goal: 'Request a refund for the provided order',
      facts: { orderId: '12345' }, constraints: ['Provide the order ID only when asked'],
      provider: { id: providerPath, config: { responses } }, maxTurns,
    },
  };
}

test('adversarial: declared stateless providers have independent local instances per trial',async t=> {
  const directory=await mkdtemp(join(tmpdir(),'one-eval-provider-isolation-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'provider.mjs');
  await writeFile(file,`export default class Provider { calls=0; id(){return 'local-state-probe'} async callApi(){return {output:String(++this.calls)}} }`);
  const target=await loadTarget({kind:'provider',provider:`file://${file}`,isolation:{mode:'stateless',scope:'independent',evidence:'No server state'},retrySafe:true},directory);
  const a=context('a'),b=context('b');const sa=await target.prepare(a),sb=await target.prepare(b);
  try {
    assert.equal((await target.execute([{role:'user',content:'same'}],sa,a)).output,'1');
    await target.cleanup(sa,a);
    assert.equal((await target.execute([{role:'user',content:'same'}],sb,b)).output,'1');
    await target.cleanup(sb,b);
  } finally {await target.close?.();}
});

test('adversarial: structured target provider errors preserve actionable status and cause',async()=> {
  const target=adapter(async()=>({error:{message:'Capacity unavailable',code:'upstream_busy'},status:503} as unknown as Awaited<ReturnType<TargetAdapter['execute']>>));
  await assert.rejects(runConversation({id:'a',input:'x',weight:1},target,null,context(),async()=>{}),error=> {
    const diagnostic=classifyError(error,'execute');
    assert.equal(diagnostic.statusCode,503);assert.equal(diagnostic.causeCode,'upstream_busy');assert.equal(diagnostic.code,'service_unavailable');return true;
  });
});

test('adversarial: Error responses preserve outer status without mutating the caller error',async()=> {
  const original = new Error('Capacity unavailable');
  const target = adapter(async()=>({error:original,status:503,code:'upstream_busy'} as unknown as TargetReply));
  await assert.rejects(runConversation({id:'a',input:'x',weight:1},target,null,context(),async()=>{}),error=> {
    const diagnostic = classifyError(error,'execute');
    assert.equal(diagnostic.statusCode,503);
    assert.equal(diagnostic.causeCode,'upstream_busy');
    assert.equal(diagnostic.code,'service_unavailable');
    assert.equal(Object.hasOwn(original,'status'),false);
    assert.equal(Object.hasOwn(original,'code'),false);
    return true;
  });
});

test('adversarial: nested response status survives structured adapter errors',async()=> {
  const target = adapter(async()=>({error:{message:'Capacity unavailable',response:{status:429}}} as unknown as TargetReply));
  await assert.rejects(runConversation({id:'a',input:'x',weight:1},target,null,context(),async()=>{}),error=> {
    const diagnostic = classifyError(error,'execute');
    assert.equal(diagnostic.statusCode,429);
    assert.equal(diagnostic.code,'rate_limit');
    assert.equal(diagnostic.retryable,true);
    return true;
  });
});

test('adversarial: usage aggregation retains prototype-named keys without inherited state',async()=> {
  const tokens=JSON.parse('{"__proto__":2,"constructor":3,"toString":4,"input":5}');
  const result=await runConversation({id:'a',input:'x',weight:1,conversation:{mode:'scripted',turns:['again']}},adapter(async()=>({output:'ok',tokenUsage:tokens})),null,context(),async()=>{});
  const usage=(result.metadata!.target as JsonObject).tokenUsage as JsonObject;
  assert.equal(Object.hasOwn(usage,'__proto__'),true);assert.equal(usage.__proto__,4);assert.equal(usage.constructor,6);assert.equal(usage.toString,8);
  assert.equal(({} as Record<string,unknown>).knownTotal,undefined);
});

test('adversarial: partial or overflowing usage never masquerades as a complete finite total',async()=> {
  let turn=0;
  const item:EvalCase={id:'a',input:'x',weight:1,conversation:{mode:'scripted',turns:['again']}};
  const partial=await runConversation(item,adapter(async():Promise<TargetReply>=>++turn===1?{output:'ok',cost:0.1,tokenUsage:{input:10}}:{output:'ok',tokenUsage:{output:2}}),null,context(),async()=>{});
  const summary=partial.metadata!.target as JsonObject;
  assert.equal(summary.cost,undefined);assert.deepEqual(summary.costCoverage,{knownCalls:1,totalCalls:2});
  const overflow=await runConversation(item,adapter(async()=>({output:'ok',cost:1e308,tokenUsage:{input:1e308}})),null,context(),async()=>{});
  assert.equal((overflow.metadata!.target as JsonObject).cost,undefined);
  assert.equal(((overflow.metadata!.target as JsonObject).tokenUsage as JsonObject|undefined)?.input,undefined);
  assert.equal(JSON.stringify(overflow.metadata).includes('null'),false);
});

test('scripted conversations preserve actual replies and start each trial with fresh history', async () => {
  const calls: Message[][] = [];
  const persisted: Message[][] = [];
  const target = adapter(async (messages) => {
    calls.push(structuredClone(messages));
    messages[0]!.content = 'adapter mutation';
    return { output: `reply ${calls.length}` };
  });
  const case1: EvalCase = {
    id: 'case-1', input: 'First question', weight: 1,
    conversation: { mode: 'scripted', turns: ['Follow-up'] },
  };
  const save = async (messages: Message[]) => {
    await Promise.resolve();
    persisted.push(structuredClone(messages));
    messages[0]!.content = 'callback mutation';
  };
  const first = await runConversation(case1, target, {}, context(), save);
  const second = await runConversation(case1, target, {}, context('trial-2'), save);
  assert.equal(first.stopReason, 'script_complete');
  assert.equal(second.stopReason, 'script_complete');
  assert.deepEqual(calls[0], [{ role: 'user', content: 'First question' }]);
  assert.deepEqual(calls[1], [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'reply 1' },
    { role: 'user', content: 'Follow-up' },
  ]);
  assert.deepEqual(calls[2], calls[0]);
  assert.deepEqual(persisted.map((messages) => messages.length), [1, 2, 3, 4, 1, 2, 3, 4]);
  assert.equal(first.messages[0]!.content, 'First question');
  assert.equal(first.output, 'reply 2');
});

test('a user turn is durably saved before target execution; empty answers are valid', async () => {
  let saved = false;
  const result = await runConversation(
    { id: 'case-1', input: 'Question', weight: 1 },
    adapter(async () => { assert.equal(saved, true); return { output: '' }; }),
    {}, context(), async () => { await Promise.resolve(); saved = true; },
  );
  assert.equal(result.output, '');
  assert.equal(result.stopReason, 'single_turn');
  assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: '' });
});

test('module targets validate lifecycle methods and isolate session data', async () => {
  const config: TargetConfig = {
    kind: 'module', path: './adapters-target.mjs', config: { label: 'session test' },
    isolation: { mode: 'managed', scope: 'independent', evidence: 'Fixture implementation' },
    retrySafe: true,
  };
  const target = await loadTarget(config, fixtures);
  for (const id of ['trial-1', 'trial-2']) {
    const trial = context(id);
    const session = await target.prepare(trial);
    assert.equal((await target.verify(session, trial)).ok, true);
    const result = await runConversation({ id: 'case-1', input: 'hello', weight: 1 }, target, session, trial, async () => {});
    assert.equal(result.output, '["hello"]');
    await target.cleanup(session, trial);
    assert.equal((await target.verify(session, trial)).ok, false);
  }
  await target.close?.();

  const temp = await mkdtemp(join(tmpdir(), 'one-eval-adapter-'));
  try {
    await writeFile(join(temp, 'invalid.mjs'), 'export default { execute() {} };');
    await assert.rejects(loadTarget({ ...config, path: 'invalid.mjs' }, temp), /requires prepare/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('provider target requires explicit stateless isolation and preserves evidence provenance', async () => {
  const config: TargetConfig = {
    kind: 'provider', provider: { id: providerPath },
    isolation: { mode: 'stateless', scope: 'independent', evidence: 'API contract version 1' },
    retrySafe: true,
  };
  await assert.rejects(loadTarget({ ...config, isolation: { ...config.isolation, mode: 'managed' } }, fixtures), /Managed isolation requires/);
  const target = await loadTarget(config, fixtures);
  const trial = context();
  const session = await target.prepare(trial);
  const verified = await target.verify(session, trial);
  assert.equal(verified.ok, true);
  assert.match(verified.evidence, /API contract version 1/);
  assert.match(verified.evidence, /not independently verified/);
  const result = await runConversation({ id: 'case-1', input: 'hello', weight: 1 }, target, session, trial, async () => {});
  assert.deepEqual(JSON.parse(result.output), [{ role: 'user', content: 'hello' }]);
  assert.equal((await target.verify(session, context('other'))).ok, false);
  const recovery = await target.recover!({ runId: trial.runId, workDir: trial.workDir, signal: trial.signal });
  assert.equal(recovery.ok, true);
  assert.match(recovery.evidence, /declared stateless isolation/);
  const calls = (result.metadata!.target as { calls: { metadata: { sawSignal: boolean } }[] }).calls;
  assert.equal(calls[0]!.metadata.sawSignal, true);
});

test('dynamic conversation follows a user message then stops; reference is hidden from the simulator', async () => {
  const targetCalls: Message[][] = [];
  const target = adapter(async (messages) => {
    targetCalls.push(messages);
    return { output: targetCalls.length === 1 ? 'What is your order ID?' : 'Your request is submitted.', cost: 0.2, tokenUsage: { total: 10 } };
  });
  const result = await runConversation(simulated([
    { action: 'message', content: 'Order 12345.' },
    { action: 'stop', reason: 'The user has no more requests.' },
  ]), target, {}, context(), async () => {});
  assert.equal(result.stopReason, 'simulator_stop');
  assert.equal(targetCalls.length, 2);
  assert.equal(result.messages[2]!.content, 'Order 12345.');
  assert.equal(result.metadata!.simulatorStopReason, 'The user has no more requests.');
  assert.equal((result.metadata!.target as JsonObjectLike).cost, 0.4);
  const simulator = result.metadata!.simulator as JsonObjectLike;
  assert.equal(simulator.cost, 0.02);
  const calls = simulator.calls as { metadata: { request: Message[]; sawSignal: boolean } }[];
  assert.equal(calls[0]!.metadata.sawSignal, true);
  const request = JSON.parse(calls[0]!.metadata.request[1]!.content);
  assert.equal(request.scenario.facts.orderId, '12345');
  assert.deepEqual(request.scenario.constraints, ['Provide the order ID only when asked']);
  assert.equal(JSON.stringify(request).includes('secret reference'), false);
  assert.equal(request.transcript.at(-1).content, 'What is your order ID?');
});

type JsonObjectLike = Record<string, unknown>;

test('dynamic trial repetitions do not reuse target history or simulator response position', async () => {
  const testCase = simulated([{ action: 'message', content: 'one follow-up' }], 2);
  const calls: Message[][] = [];
  const target = adapter(async (messages) => { calls.push(messages); return { output: 'reply' }; });
  for (const trial of [context(), context('trial-2')]) {
    const result = await runConversation(testCase, target, {}, trial, async () => {});
    assert.equal(result.stopReason, 'max_turns');
    assert.equal(result.messages[2]!.content, 'one follow-up');
  }
  assert.deepEqual(calls.map((messages) => messages.length), [1, 3, 1, 3]);
});

test('invalid simulator output retains completed target turn and fails with a distinct error', async () => {
  const persisted: Message[][] = [];
  const evidence: JsonObject[] = [];
  await assert.rejects(runConversation(
    simulated(['```json\n{"action":"stop","reason":"done"}\n```']),
    adapter(async () => ({ output: 'initial reply', metadata: { orderState: 'refunded', traceId: 'trace-1' }, cost: 0.25 })), {}, context(),
    async (messages, metadata) => { persisted.push(messages); evidence.push(metadata!); },
  ), InvalidSimulationError);
  assert.deepEqual(persisted.map((messages) => messages.length), [1, 2, 2]);
  assert.equal(persisted.at(-1)!.at(-1)!.content, 'initial reply');
  const saved = evidence.at(-1)!;
  assert.deepEqual(saved.target, { calls: [{ turn: 1, metadata: { orderState: 'refunded', traceId: 'trace-1' }, cost: 0.25 }], cost: 0.25 });
  const simulator = saved.simulator as { calls: { output: string }[]; cost: number };
  assert.equal(simulator.calls[0]!.output, '```json\n{"action":"stop","reason":"done"}\n```');
  assert.equal(simulator.cost, 0.01);
});

test('simulator setup failures preserve the cause and prevent all target calls', async () => {
  const testCase = simulated([]);
  if (testCase.conversation?.mode !== 'simulated') throw new Error('Invalid fixture');
  testCase.conversation.provider = { id: providerPath, config: { secret: '${ENV:ONE_EVAL_TEST_MISSING_SIMULATOR_CREDENTIAL}' } };
  assert.equal(process.env.ONE_EVAL_TEST_MISSING_SIMULATOR_CREDENTIAL, undefined);
  let targetCalls = 0;
  await assert.rejects(runConversation(
    testCase, adapter(async () => { targetCalls++; return { output: 'should not happen' }; }), {}, context(), async () => {},
  ), (error: unknown) => error instanceof SystemicSimulationError && /Missing environment variable/.test(error.message) && error.cause instanceof Error);
  assert.equal(targetCalls, 0);
});

test('simulator authentication failures are distinguished from per-case malformed output', async () => {
  const testCase = simulated([]);
  if (testCase.conversation?.mode !== 'simulated') throw new Error('Invalid fixture');
  testCase.conversation.provider = { id: providerPath, config: { error: 'HTTP 401 Unauthorized' } };
  await assert.rejects(runConversation(
    testCase, adapter(async () => ({ output: 'initial reply' })), {}, context(), async () => {},
  ), (error: unknown) => error instanceof SystemicSimulationError && /401 Unauthorized/.test(error.message));
});

test('evidence is persisted before the next target call and cannot be mutated by the callback', async () => {
  let persistedTargetCalls = 0;
  let calls = 0;
  const result = await runConversation(
    { id: 'case-1', input: 'first', weight: 1, conversation: { mode: 'scripted', turns: ['second'] } },
    adapter(async () => {
      assert.equal(persistedTargetCalls, calls);
      calls++;
      return { output: `reply-${calls}`, metadata: { traceId: `trace-${calls}` }, cost: 0.1 };
    }), {}, context(), async (_messages, metadata) => {
      const saved = metadata!.target as { calls: JsonObject[] };
      persistedTargetCalls = saved.calls.length;
      saved.calls.splice(0); // The observer must not mutate the live conversation evidence.
    },
  );
  assert.equal((result.metadata!.target as { calls: JsonObject[] }).calls.length, 2);
  assert.equal((result.metadata!.target as { cost: number }).cost, 0.2);
});

test('a later target failure retains earlier tool evidence', async () => {
  let saved: JsonObject | undefined;
  let calls = 0;
  await assert.rejects(runConversation(
    { id: 'case-1', input: 'first', weight: 1, conversation: { mode: 'scripted', turns: ['second'] } },
    adapter(async () => { if (++calls === 2) throw new Error('target unavailable'); return { output: 'refund confirmed', metadata: { orderState: 'refunded' } }; }),
    {}, context(), async (_messages, metadata) => { saved = metadata; },
  ), /target unavailable/);
  assert.deepEqual((saved!.target as { calls: JsonObject[] }).calls[0], { turn: 1, metadata: { orderState: 'refunded' } });
});

test('target failure during dynamic conversation remains an execution failure', async () => {
  let calls = 0;
  await assert.rejects(runConversation(
    simulated([{ action: 'message', content: 'Follow-up' }]),
    adapter(async () => { if (++calls === 2) throw new Error('target unavailable'); return { output: 'reply' }; }),
    {}, context(), async () => {},
  ), (error: unknown) => error instanceof Error && !(error instanceof InvalidSimulationError) && error.message === 'target unavailable');
});

test('malformed target replies and explicit provider errors are rejected', async () => {
  for (const response of [{ output: 42 }, { output: 'misleading answer', error: 'HTTP 401' }]) {
    await assert.rejects(runConversation(
      { id: 'case-1', input: 'hello', weight: 1 },
      adapter(async () => response as unknown as Awaited<ReturnType<TargetAdapter['execute']>>),
      {}, context(), async () => {},
    ), /output must be a string|HTTP 401/);
  }
});

test('undefined optional SDK token fields normalize to a stable JSON artifact', async () => {
  const result = await runConversation(
    { id: 'case-1', input: 'hello', weight: 1 },
    adapter(async () => ({ output: 'answer', tokenUsage: { total: 3, completionDetails: { reasoning: undefined } } } as unknown as Awaited<ReturnType<TargetAdapter['execute']>>)),
    {}, context(), async () => {},
  );
  const calls = (result.metadata!.target as { calls: { tokenUsage: Json }[] }).calls;
  assert.deepEqual(calls[0]!.tokenUsage, { total: 3, completionDetails: {} });
});

test('loading a modified module uses its new source version in the same process', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'one-eval-adapter-version-'));
  const modulePath = join(temp, 'target.mjs');
  const config: TargetConfig = {
    kind: 'module', path: modulePath, retrySafe: true,
    isolation: { mode: 'managed', scope: 'independent', evidence: 'Version fixture' },
  };
  const source = (output: string) => `export function createTarget() { return {
    async prepare() { return {}; }, async verify() { return {ok: true, evidence: 'fixture'}; },
    async execute() { return {output: ${JSON.stringify(output)}}; }, async cleanup() {}
  }; }`;
  try {
    await writeFile(modulePath, source('version 1'));
    const first = await loadTarget(config, temp);
    await writeFile(modulePath, source('version 2'));
    const second = await loadTarget(config, temp);
    assert.equal((await first.execute([], {}, context())).output, 'version 1');
    assert.equal((await second.execute([], {}, context())).output, 'version 2');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('abort signal reaches the adapter and prevents another turn or a late response from persisting', async () => {
  const controller = new AbortController();
  const snapshots: Message[][] = [];
  let calls = 0;
  await assert.rejects(runConversation(
    { id: 'case-1', input: 'hello', weight: 1, conversation: { mode: 'scripted', turns: ['again'] } },
    adapter(async (_messages, _session, trial) => {
      calls++;
      assert.equal(trial.signal, controller.signal);
      controller.abort(new Error('test cancellation'));
      return { output: 'late output' };
    }), {}, context('trial-1', controller.signal), async (messages) => { snapshots.push(messages); },
  ), /test cancellation/);
  assert.equal(calls, 1);
  assert.deepEqual(snapshots, [[{ role: 'user', content: 'hello' }]]);
});
