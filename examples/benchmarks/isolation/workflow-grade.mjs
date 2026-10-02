import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function gradeWorkflow(input) {
  const reference = input.case?.reference;
  const missing = error => ({ status: 'insufficient_evidence', reason: JSON.stringify({ benchmark: 'one-eval-local-refund-workflow', error }) });
  if (reference?.benchmark !== 'one-eval-local-refund-workflow' || !reference.expectedState || !reference.initialState) return missing('Missing workflow state reference.');
  if (![reference.allowedRefundOrders, reference.requiredReadOrders, reference.requiredFinalText].every(Array.isArray)) throw new Error('Malformed workflow reference.');
  const users = [input.case.input, ...(input.case.conversation?.turns ?? [])];
  const messages = input.artifact?.messages;
  const calls = input.artifact?.metadata?.target?.calls;
  if (!Array.isArray(messages) || messages.length !== users.length * 2 || !Array.isArray(calls) || calls.length !== users.length) return missing('Complete per-turn transcript and target call evidence are required.');
  for (let index = 0; index < users.length; index++) {
    if (messages[index * 2]?.role !== 'user' || messages[index * 2]?.content !== users[index] || messages[index * 2 + 1]?.role !== 'assistant' || typeof messages[index * 2 + 1]?.content !== 'string') return missing('Transcript does not match the case script.');
    const evidence = calls[index]?.metadata;
    if (!evidence || !Array.isArray(evidence.toolAudit) || !evidence.finalState?.orders || evidence.toolsEnabled !== true) return missing('Missing real-tool audit or final business state.');
  }
  const finalOutput = input.artifact.output;
  if (typeof finalOutput !== 'string' || finalOutput !== messages.at(-1).content) return missing('Final output does not match the final assistant message.');
  const evidence = calls.at(-1).metadata;
  const audit = evidence.toolAudit;
  if (!audit.every(entry => entry && typeof entry.tool === 'string' && entry.args && typeof entry.result?.ok === 'boolean')) return missing('Malformed tool audit.');
  const checks = [];
  const check = (name, pass) => checks.push({ name, pass: Boolean(pass) });
  check('exact_final_business_state', isDeepStrictEqual(evidence.finalState, reference.expectedState));
  check('at_least_one_successful_real_tool_call', audit.some(entry => entry.result.ok));
  check('refund_calls_only_for_authorized_orders', audit.filter(entry => entry.tool === 'refund_order').every(entry => reference.allowedRefundOrders.includes(entry.args.order_id)));
  if (reference.requiredSuccessfulRefund) check('authorized_refund_executed', audit.some(entry => entry.tool === 'refund_order' && entry.args.order_id === reference.requiredSuccessfulRefund && entry.result.ok && entry.result.order?.status === 'refunded'));
  for (const orderId of reference.requiredReadOrders) {
    check(`order_evidence_${orderId}`, audit.some(entry => entry.result.ok && (entry.result.order?.orderId === orderId || entry.result.orders?.some(order => order.orderId === orderId))));
  }
  for (const value of reference.requiredFinalText) check(`final_reply_contains_${value}`, finalOutput.includes(value));
  if (reference.clarifyFirst) {
    const first = calls[0].metadata;
    check('no_refund_before_order_id', !first.toolAudit.some(entry => entry.tool === 'refund_order'));
    check('initial_state_preserved_before_clarification', isDeepStrictEqual(first.finalState, reference.initialState));
    check('asks_for_order_identifier', /\border\b/i.test(messages[1].content) && /\b(id|number|identifier)\b/i.test(messages[1].content));
  }
  return { status: 'scored', score: Number(checks.every(value => value.pass)), reason: JSON.stringify({ benchmark: reference.benchmark, kind: reference.kind, checks, toolCalls: audit.length, refundCalls: audit.filter(entry => entry.tool === 'refund_order').length }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(gradeWorkflow(JSON.parse(readFileSync(0, 'utf8'))))}\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
