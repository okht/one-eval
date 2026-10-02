import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error acceptance example uses native ESM.
import { argumentsFor, parseEvents, invokeCodex } from '../examples/acceptance/codex-run.mjs';
// @ts-expect-error acceptance example uses native ESM.
import { startNativeService } from '../examples/acceptance/native-http-target.mjs';

const events = (thread = 'thread-a', extra: object[] = []) => [
  { type: 'thread.started', thread_id: thread }, { type: 'turn.started' }, ...extra,
  { type: 'item.completed', item: { type: 'agent_message', text: '上海🌏' } },
  { type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2, cached_input_tokens: 0 } },
].map(event => JSON.stringify(event)).join('\n');

test('native acceptance verifies resume identity and rejects tool activity/errors', () => {
  assert.equal(parseEvents(events(), 'thread-a').output, '上海🌏');
  assert.throws(() => parseEvents(events(), 'thread-b'), /thread ID/);
  assert.throws(() => parseEvents(events('thread-a', [{ type: 'item.started', item: { type: 'command_execution' } }])), /tool activity/);
  assert.throws(() => parseEvents(events('thread-a', [{ type: 'error', message: 'quota exceeded' }])), /quota exceeded/);
  const fresh = argumentsFor({ model: 'model-a' });
  const resume = argumentsFor({ model: 'model-a', threadId: 'thread-a', ephemeral: false });
  assert.ok(fresh.includes('--ephemeral'));
  assert.deepEqual(resume.slice(0, 3), ['exec', 'resume', 'thread-a']);
  assert.ok(!resume.includes('--ephemeral'));
  assert.ok(resume.includes('features.memories=false'));
});

test('acceptance call budget prevents starting any child when exhausted', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-budget-test-'));
  t.after(() => rm(directory, { recursive: true }));
  await assert.rejects(invokeCodex({ binaryPath: process.execPath, model: 'test', prompt: 'test', cwd: directory, evidenceDir: directory, maxCalls: 0 }), /budget exhausted/);
});

test('loopback service owns a native thread, sends only latest turn, and revokes cleaned sessions', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-native-service-test-'));
  const calls: any[] = [];
  const service = await startNativeService({ auditFile: path.join(directory, 'audit.jsonl'), binaryPath: process.execPath, model: 'fixture', evidenceDir: directory }, { invoke: async (input: any) => {
    calls.push(input);
    return { output: input.threadId ? 'VALUE' : 'STORED', threadId: input.threadId ?? `thread-${calls.length}`, usage: { input_tokens: 4, output_tokens: 1, cached_input_tokens: 0 }, callId: `call-${calls.length}`, requestedModel: 'fixture' };
  } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true }); });
  const request = async (method: string, suffix: string, body?: unknown) => fetch(service.url + suffix, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const created = await (await request('POST', '/sessions')).json() as any;
  const route = `/sessions/${created.sessionId}`;
  const initial = await (await request('GET', route)).json() as any;
  assert.equal(initial.threadId, null); assert.equal(initial.turns, 0); assert.equal(initial.emptyDirectory, true);
  const first = await (await request('POST', `${route}/turns`, { message: 'Store VALUE' })).json() as any;
  const second = await (await request('POST', `${route}/turns`, { message: 'Recall' })).json() as any;
  assert.equal(first.metadata.nativeThreadId, second.metadata.nativeThreadId);
  assert.equal(calls[1].prompt, 'Recall');
  assert.equal(calls[1].threadId, 'thread-1'); assert.equal(calls[1].ephemeral, false);
  const deleted = await (await request('DELETE', route)).json() as any;
  assert.equal(deleted.directoryRemoved, true); assert.equal((await request('GET', route)).status, 404);
  const next = await (await request('POST', '/sessions')).json() as any;
  assert.notEqual(next.sessionId, created.sessionId);
  await request('POST', `/sessions/${next.sessionId}/turns`, { message: 'Blank' });
  assert.equal(calls[2].threadId, undefined);
  await request('DELETE', `/sessions/${next.sessionId}`);
  const audit = (await readFile(path.join(directory, 'audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.filter(event => event.type === 'session.deleted' && event.directoryRemoved).length, 2);
});
