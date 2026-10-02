import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function gradeNative(input) {
  const reference = input.case?.reference;
  const artifact = input.artifact;
  const missing = reason => ({ status: 'insufficient_evidence', reason });
  if (reference?.benchmark !== 'acceptance-v2-native' || !Array.isArray(reference.expectedReplies)) return missing('Missing native acceptance reference');
  const calls = artifact?.metadata?.target?.calls;
  if (!Array.isArray(calls) || !calls.length || !Array.isArray(artifact.messages)) return missing('Missing recorded calls or transcript');
  const canaries = new Set(calls.map(call => call.metadata?.canary));
  const threads = new Set(calls.map(call => call.metadata?.nativeThreadId));
  const canary = calls[0].metadata?.canary;
  const boundCanary = `CANARY_${createHash('sha256').update(JSON.stringify([artifact.runId, artifact.trialId, artifact.repeat, artifact.attempt, artifact.sessionId])).digest('hex').slice(0, 20)}`;
  if (canary !== boundCanary) return { status: 'scored', score: 0, reason: 'Isolation canary is bound to a different trial/repeat/attempt/session' };
  if (canaries.size !== 1 || !/^CANARY_[a-f0-9]{20}$/.test(canary ?? '') || threads.size !== 1) return { status: 'scored', score: 0, reason: 'One trial used inconsistent isolation canaries or native threads' };
  if (artifact.messages.length !== calls.length * 2 || artifact.messages.some((message, index) => message.role !== (index % 2 ? 'assistant' : 'user'))) return missing('Incomplete alternating transcript');
  if (artifact.messages[0].content !== input.case.input) return missing('First input differs from the frozen case');
  const userMessages = artifact.messages.filter(message => message.role === 'user').map(message => message.content);
  if (!reference.simulated && JSON.stringify(userMessages) !== JSON.stringify([input.case.input, ...(input.case.conversation?.turns ?? [])])) return missing('Transcript differs from the frozen case script');
  const replies = artifact.messages.filter(message => message.role === 'assistant').map(message => message.content.trim());
  if (artifact.output?.trim() !== replies.at(-1)) return missing('Final output differs from transcript');
  const expected = reference.expectedReplies.map(text => text.replaceAll('__TRIAL_SECRET__', canary).replaceAll('__TRIAL_UPDATE__', `${canary}_UPDATED`));
  const checks = expected.map((value, index) => ({ turn: index + 1, expected: value, actual: replies[index] ?? null, pass: replies[index] === value }));
  const foreignTokens = replies.flatMap(text => text.match(/CANARY_[a-f0-9]{20}(?:_UPDATED)?/g) ?? []).filter(token => token !== canary && token !== `${canary}_UPDATED`);
  const nativeProgression = calls.every((call, index) => call.metadata?.turn === index + 1 && call.metadata.nativeResume === (index > 0) && call.metadata.transport === 'latest_message_only' && call.metadata.transportInput === userMessages[index].replaceAll('__TRIAL_SECRET__', canary).replaceAll('__TRIAL_UPDATE__', `${canary}_UPDATED`));
  const expectedStop = reference.simulated ? artifact.stopReason === 'simulator_stop' : ['script_complete', 'single_turn'].includes(artifact.stopReason);
  const simulatorCalls = artifact.metadata?.simulator?.calls ?? [];
  const simulatorProtocol = !reference.simulated || (simulatorCalls.length === calls.length && simulatorCalls.every((call, index) => {
    try { const action = JSON.parse(call.output); return index === simulatorCalls.length - 1 ? action.action === 'stop' : action.action === 'message'; } catch { return false; }
  }));
  const pass = replies.length === expected.length && checks.every(check => check.pass) && !foreignTokens.length && nativeProgression && expectedStop && simulatorProtocol;
  return { status: 'scored', score: Number(pass), reason: JSON.stringify({ checks, foreignTokens, nativeProgression, expectedStop, simulatorProtocol, observedReplies: replies.length, expectedReplies: expected.length, finalValueCorrect: replies.at(-1) === expected.at(-1) }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(gradeNative(JSON.parse(readFileSync(0, 'utf8'))))}\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
