import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function gradeIsolation(input) {
  const reference = input.case?.reference;
  const missing = error => ({ status: 'insufficient_evidence', reason: JSON.stringify({ benchmark: 'one-eval-context-isolation', error }) });
  if (reference?.benchmark !== 'one-eval-context-isolation' || !Array.isArray(reference.expectedReplies) || !reference.expectedReplies.length) return missing('Missing isolation reference.');
  if (!reference.expectedReplies.every(value => typeof value === 'string') || !Array.isArray(reference.forbiddenTokens) || !reference.forbiddenTokens.every(value => typeof value === 'string')) throw new Error('Malformed isolation reference.');
  const users = [input.case.input, ...(input.case.conversation?.turns ?? [])];
  if (users.length !== reference.expectedReplies.length) throw new Error('Reference reply count differs from the scripted turn count.');
  const messages = input.artifact?.messages;
  if (!Array.isArray(messages) || messages.length !== users.length * 2) return missing('A complete alternating user/assistant transcript is required.');
  const actual = [];
  for (let index = 0; index < users.length; index++) {
    const user = messages[index * 2], assistant = messages[index * 2 + 1];
    if (user.role !== 'user' || user.content !== users[index] || assistant.role !== 'assistant' || typeof assistant.content !== 'string') return missing('Transcript does not match the case script.');
    actual.push(assistant.content.trim());
  }
  if (typeof input.artifact.output !== 'string' || input.artifact.output.trim() !== actual.at(-1)) return missing('Final output does not match the final assistant message.');
  const checks = actual.map((value, index) => ({ turn: index + 1, expected: reference.expectedReplies[index], actual: value, pass: value === reference.expectedReplies[index] }));
  const leakedTokens = reference.forbiddenTokens.filter(token => actual.some(reply => reply.includes(token)));
  return { status: 'scored', score: Number(checks.every(check => check.pass) && leakedTokens.length === 0), reason: JSON.stringify({ benchmark: reference.benchmark, kind: reference.kind, checks, leakedTokens }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(gradeIsolation(JSON.parse(readFileSync(0, 'utf8'))))}\n`); }
  catch (error) { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; }
}
