import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'examples/benchmarks/isolation');
const { createIsolationCases } = await import(pathToFileURL(path.join(folder, 'cases.mjs')).href);
const { gradeIsolation } = await import(pathToFileURL(path.join(folder, 'grade.mjs')).href);
const { createWorkflowCases, expectedInitialState } = await import(pathToFileURL(path.join(folder, 'workflow-cases.mjs')).href);
const { gradeWorkflow } = await import(pathToFileURL(path.join(folder, 'workflow-grade.mjs')).href);

function transcript(item: any, replies: string[]) {
  return [item.input, ...(item.conversation?.turns ?? [])].flatMap((content: string, index: number) => [{ role: 'user', content }, { role: 'assistant', content: replies[index] }]);
}
function isolationInput(item: any, replies: string[] = item.reference.expectedReplies) {
  return { case: item, artifact: { output: replies.at(-1), messages: transcript(item, replies) }, judgeId: 'fixture', repeat: 0, instructions: '' };
}

test('isolation challenge keeps eight cases, repeated blanks, and synthetic deterministic tokens', () => {
  const cases = createIsolationCases();
  assert.equal(cases.length, 8);
  assert.equal(cases.reduce((sum: number, item: any) => sum + 1 + (item.conversation?.turns.length ?? 0), 0), 19);
  assert.deepEqual(cases, createIsolationCases());
  assert.notDeepEqual(cases, createIsolationCases('different-seed'));
  for (const item of cases.filter((item: any) => item.reference.kind === 'cross_case_blank')) {
    assert.ok(!JSON.stringify({ input: item.input, metadata: item.metadata }).includes('vlt_'));
    assert.deepEqual(item.reference.expectedReplies, ['UNKNOWN']);
  }
  for (const item of cases) assert.equal(gradeIsolation(isolationInput(item)).score, 1);
});

test('isolation grader rejects actual cross-case token leakage, lost memory, stale overwrite, and failed clear', () => {
  const cases = createIsolationCases();
  const secret = cases[0].reference.expectedReplies.at(-1);
  const leak = gradeIsolation(isolationInput(cases[1], [secret]));
  assert.equal(leak.score, 0);
  assert.deepEqual(JSON.parse(leak.reason).leakedTokens, [secret]);
  assert.equal(gradeIsolation(isolationInput(cases[0], ['STORED', '17', 'UNKNOWN'])).score, 0);
  const overwrite = cases[6];
  const oldToken = /vlt_[a-f0-9]+/.exec(overwrite.input)![0];
  assert.equal(gradeIsolation(isolationInput(overwrite, ['STORED', 'UPDATED', '11', oldToken])).score, 0);
  const clear = cases[7];
  assert.equal(gradeIsolation(isolationInput(clear, ['STORED', 'CLEARED', /vlt_[a-f0-9]+/.exec(clear.input)![0]])).score, 0);
  const missing = isolationInput(cases[0]); missing.artifact.messages.pop();
  assert.equal(gradeIsolation(missing).status, 'insufficient_evidence');
});

function workflowInput(item: any) {
  const turns = 1 + (item.conversation?.turns.length ?? 0);
  const replies = Array.from({ length: turns }, (_, index) => item.reference.clarifyFirst && index === 0 ? 'What is your order ID?' : item.reference.requiredFinalText.join(' '));
  const readIds = new Set<string>(item.reference.requiredReadOrders);
  if (item.reference.requiredSuccessfulRefund) readIds.add(item.reference.requiredSuccessfulRefund);
  const audit: any[] = [...readIds].map((orderId, index) => ({ sequence: index + 1, tool: 'get_order', args: { order_id: orderId }, result: { ok: true, order: item.reference.initialState.orders[orderId] } }));
  if (item.reference.requiredSuccessfulRefund) audit.push({ sequence: audit.length + 1, tool: 'refund_order', args: { order_id: item.reference.requiredSuccessfulRefund, reason: item.reference.expectedState.orders[item.reference.requiredSuccessfulRefund].refundReason }, result: { ok: true, order: item.reference.expectedState.orders[item.reference.requiredSuccessfulRefund] } });
  const calls = Array.from({ length: turns }, (_, index) => ({ metadata: { toolsEnabled: true, toolAudit: item.reference.clarifyFirst && index === 0 ? [] : structuredClone(audit), finalState: structuredClone(item.reference.clarifyFirst && index === 0 ? item.reference.initialState : item.reference.expectedState) } }));
  return { case: item, artifact: { output: replies.at(-1), messages: transcript(item, replies), metadata: { target: { calls } } }, judgeId: 'fixture', repeat: 0, instructions: '' };
}

test('workflow fixed oracle matches the backend fixture and complete authorized outcomes pass', async () => {
  const { initialState } = await import(pathToFileURL(path.join(root, 'examples/benchmarks/agent-workflow/fixture.mjs')).href);
  assert.deepEqual(expectedInitialState(), initialState());
  const cases = createWorkflowCases();
  assert.equal(cases.length, 8);
  assert.equal(cases.reduce((sum: number, item: any) => sum + 1 + (item.conversation?.turns.length ?? 0), 0), 11);
  for (const item of cases) assert.equal(gradeWorkflow(workflowInput(item)).score, 1, item.id);
});

test('workflow grader detects unrelated mutation, unauthorized tool call, duplicate refund, and missing tool evidence', () => {
  const cases = createWorkflowCases();
  const mutated = workflowInput(cases[4]);
  mutated.artifact.metadata.target.calls.at(-1)!.metadata.finalState.orders['ORD-100'].amount = 999;
  assert.equal(gradeWorkflow(mutated).score, 0);
  const readOnly = workflowInput(cases[5]);
  readOnly.artifact.metadata.target.calls[0]!.metadata.toolAudit.push({ sequence: 3, tool: 'refund_order', args: { order_id: 'ORD-100' }, result: { ok: false } });
  assert.equal(gradeWorkflow(readOnly).score, 0);
  const duplicate = workflowInput(cases[1]);
  duplicate.artifact.metadata.target.calls.at(-1)!.metadata.finalState.orders['ORD-103'].refundCount = 2;
  assert.equal(gradeWorkflow(duplicate).score, 0);
  const noTool = workflowInput(cases[4]);
  for (const call of noTool.artifact.metadata.target.calls) call.metadata.toolAudit = [];
  assert.equal(gradeWorkflow(noTool).score, 0);
  const noEvidence = workflowInput(cases[4]); noEvidence.artifact.metadata.target.calls = [];
  assert.equal(gradeWorkflow(noEvidence).status, 'insufficient_evidence');
});

test('workflow grader rejects a refund performed before order-ID clarification', () => {
  const item = createWorkflowCases()[0];
  const input = workflowInput(item);
  input.artifact.metadata.target.calls[0]!.metadata = structuredClone(input.artifact.metadata.target.calls[1]!.metadata);
  assert.equal(gradeWorkflow(input).score, 0);
});

test('both challenge graders implement the JSON-stdin command protocol', () => {
  for (const [file, input] of [['grade.mjs', isolationInput(createIsolationCases()[0])], ['workflow-grade.mjs', workflowInput(createWorkflowCases()[0])]] as const) {
    const result = spawnSync(process.execPath, [path.join(folder, file)], { input: JSON.stringify(input), encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).score, 1);
  }
});
