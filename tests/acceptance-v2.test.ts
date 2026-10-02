import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Native ESM acceptance fixture.
import { makeFixtures } from '../examples/acceptance-v2/fixtures.mjs';
// @ts-expect-error Native ESM acceptance adapter.
import { canaryFor, createTarget } from '../examples/acceptance-v2/native-canary-target.mjs';
// @ts-expect-error Native ESM acceptance grader.
import { gradeNative } from '../examples/acceptance-v2/grade-native.mjs';

test('v2 preregistered fixtures preserve newline escapes and normalization counterexamples without exposing labels', () => {
  const { cases, gold } = makeFixtures();
  assert.equal(cases.length, 24); assert.equal(gold.length, 24);
  for (const item of cases) { assert.equal(item.label, undefined); assert.equal(item.expected, undefined); }
  const escaped = cases.find((item: any) => item.id === 'item-13');
  assert.deepEqual(JSON.parse(escaped.output), escaped.reference.expected);
  assert.ok(JSON.parse(escaped.output).text.includes('\n第二行'));
  const normalized = cases.find((item: any) => item.id === 'item-12');
  assert.notEqual(normalized.output, normalized.reference.expected);
  assert.equal(normalized.output.normalize('NFC'), normalized.reference.expected);
  assert.deepEqual(gold.filter((item: any) => item.expected.status !== 'scored').map((item: any) => item.expected.status), ['insufficient_evidence', 'abstained', 'insufficient_evidence']);
});

test('canary wrapper supplies independent concurrent session values without rewriting the stored transcript', async () => {
  const received: any[] = [];
  const adapter = await createTarget({}, { createNativeTarget: async () => ({
    prepare: async (context: any) => ({ trialSessionId: context.sessionId, serviceId: context.sessionId }),
    verify: async () => ({ ok: true, evidence: 'fixture session' }),
    execute: async (messages: any, session: any) => { received.push({ messages, serviceId: session.serviceId }); return { output: 'STORED', metadata: {} }; },
    cleanup: async () => {}, close: async () => {},
  }) });
  const contexts = [0, 1, 2].map(repeat => ({ runId: 'run', trialId: `trial-${repeat}`, repeat, attempt: 1, sessionId: `session-${repeat}` }));
  const source = [{ role: 'user', content: 'Store __TRIAL_SECRET__' }];
  await Promise.all(contexts.map(async context => { const session = await adapter.prepare(context); assert.equal((await adapter.verify(session, context)).ok, true); await adapter.execute(source, session, context); }));
  assert.equal(new Set(received.map(item => item.messages[0].content)).size, 3);
  assert.equal(source[0]!.content, 'Store __TRIAL_SECRET__');
  assert.notEqual(canaryFor(contexts[0]), canaryFor({ ...contexts[0], attempt: 2 }));
});

function evidence() {
  const artifact: any = { runId: 'run', trialId: 'trial', repeat: 0, attempt: 1, sessionId: 'session', stopReason: 'script_complete' };
  const canary = canaryFor(artifact);
  const user = ['Store __TRIAL_SECRET__', 'Recall'];
  artifact.messages = [{ role: 'user', content: user[0] }, { role: 'assistant', content: 'STORED' }, { role: 'user', content: user[1] }, { role: 'assistant', content: canary }];
  artifact.output = canary;
  artifact.metadata = { target: { calls: user.map((content, index) => ({ metadata: { canary, nativeThreadId: 'native-thread', turn: index + 1, nativeResume: index > 0, transport: 'latest_message_only', transportInput: content!.replace('__TRIAL_SECRET__', canary) } })) } };
  return { case: { input: user[0], conversation: { turns: [user[1]] }, reference: { benchmark: 'acceptance-v2-native', expectedReplies: ['STORED', '__TRIAL_SECRET__'] } }, artifact };
}

test('native acceptance rejects a foreign canary, transcript replay and transplanted trial evidence', () => {
  const good = evidence(); assert.equal(gradeNative(good).score, 1);
  const foreign = structuredClone(good); foreign.artifact.output = 'CANARY_11111111111111111111'; foreign.artifact.messages[3].content = foreign.artifact.output;
  assert.equal(gradeNative(foreign).score, 0);
  const replayed = structuredClone(good); replayed.artifact.metadata.target.calls[1].metadata.transportInput = 'Store token. STORED. Recall';
  assert.equal(gradeNative(replayed).score, 0);
  const transplanted = structuredClone(good); transplanted.artifact.sessionId = 'other-session';
  assert.equal(gradeNative(transplanted).score, 0);
});

test('simulated-user acceptance detects a missing stop and invalid action progression', () => {
  const good = evidence(); good.case.reference = { ...good.case.reference, simulated: true } as any;
  good.artifact.stopReason = 'simulator_stop';
  good.artifact.metadata.simulator = { calls: [{ output: '{"action":"message","content":"Recall"}' }, { output: '{"action":"stop","reason":"Received value"}' }] };
  assert.equal(gradeNative(good).score, 1);
  good.artifact.stopReason = 'max_turns'; assert.equal(gradeNative(good).score, 0);
  good.artifact.stopReason = 'simulator_stop'; good.artifact.metadata.simulator.calls[1].output = '{"action":"message","content":"Continue"}';
  assert.equal(gradeNative(good).score, 0);
});
