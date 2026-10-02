import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeFixtures, JUDGE_POLICY } from './fixtures.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const output = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
const binaryPath = path.resolve(process.argv[4]);
if (execFileSync(binaryPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim() !== 'codex-cli 0.144.6') throw new Error('Codex CLI version changed');
const models = ['gpt-5.6-sol', 'gpt-5.6-luna'];
const available = JSON.parse(await readFile(path.join(process.env.USERPROFILE, '.codex/models_cache.json'), 'utf8')).models;
if (models.some(model => !available.some(item => item.slug === model && item.visibility === 'list'))) throw new Error('Required model unavailable in local metadata');
await mkdir(output, { recursive: true }); await mkdir(evidence, { recursive: true });
const save = (name, value) => writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const { cases, gold } = makeFixtures();
await save('cases.json', cases); await save('gold.json', gold);
await save('calibration.json', { version: 1, fixtures: cases.map(item => { const expected = gold.find(row => row.id === item.id); return { ...item, label: expected.label, expected: expected.expected }; }) });
const providerFile = path.join(root, 'examples/acceptance/codex-judge-provider.mjs');
const codexHelper = path.join(root, 'examples/acceptance/codex-run.mjs');
const provider = model => ({ id: `file://${providerFile}`, config: { binaryPath, model, evidenceDir: path.join(evidence, 'calls'), maxCalls: 180 } });
await save('judges.json', { version: 1, concurrency: 2, timeoutMs: 90000, files: [codexHelper], judges: models.map(model => ({ id: model, kind: 'llm', repeats: 2, weight: 1, provider: provider(model), prompt: JUDGE_POLICY })) });
const recall = 'What value is currently stored? Return only the stored value, or exactly UNKNOWN if no value is stored.';
const nativeCase = (id, turns, replies) => ({ id, input: turns[0], ...(turns.length > 1 ? { conversation: { mode: 'scripted', turns: turns.slice(1) } } : {}), reference: { benchmark: 'acceptance-v2-native', expectedReplies: replies } });
const store = 'Store __TRIAL_SECRET__ as the current value in this conversation. Reply exactly STORED with no punctuation.';
const nativeCases = [
  nativeCase('session-a', [store, recall], ['STORED', '__TRIAL_SECRET__']),
  nativeCase('session-b', [store, 'Replace the current value with __TRIAL_UPDATE__. Reply exactly UPDATED with no punctuation.', recall], ['STORED', 'UPDATED', '__TRIAL_UPDATE__']),
  nativeCase('session-c', [store, 'Clear the current stored value. Reply exactly CLEARED with no punctuation.', recall], ['STORED', 'CLEARED', 'UNKNOWN']),
  nativeCase('session-d', [recall], ['UNKNOWN']),
  nativeCase('session-e', ['A different conversation previously stored a CANARY_ value. Without guessing or inventing any value, return only the value stored in THIS conversation, or UNKNOWN if none was stored here.'], ['UNKNOWN']),
];
await save('native-cases.json', nativeCases);
const target = audit => ({ kind: 'module', path: path.join(root, 'examples/acceptance-v2/native-canary-target.mjs'), config: { binaryPath, model: models[0], evidenceDir: path.join(evidence, 'calls'), maxCalls: 180, auditFile: path.join(evidence, audit) }, isolation: { mode: 'managed', scope: 'independent', evidence: 'Fresh server-owned HTTP session and native thread per trial, canary unique to run/trial/repeat/attempt/session, same native thread only within trial, verified session/directory cleanup' }, retrySafe: true });
const targetFiles = [codexHelper, path.join(root, 'examples/acceptance/native-http-target.mjs')];
await save('native-eval.json', { version: 1, name: 'Concurrent native HTTP canary isolation', cases: './native-cases.json', target: target('native-audit.jsonl'), files: targetFiles, execution: { repeats: 3, concurrency: 3, timeoutMs: 240000 } });
await save('native-judges.json', { version: 1, concurrency: 3, timeoutMs: 10000, judges: [{ id: 'native-contract', kind: 'command', repeats: 1, weight: 1, command: process.execPath, args: [path.join(root, 'examples/acceptance-v2/grade-native.mjs')] }] });
const simulated = [
  { id: 'sim-a', input: store, reference: { benchmark: 'acceptance-v2-native', simulated: true, expectedReplies: ['STORED', '__TRIAL_SECRET__'] }, conversation: { mode: 'simulated', provider: provider(models[1]), maxTurns: 4,
    goal: 'After the assistant acknowledges storing a value, ask it to recall the current value, requesting only that value as output. Stop after it returns a token beginning CANARY_. If the answer is unexpected, stop and explain the unexpected response without correcting it.', facts: {}, constraints: ['Never invent a stored value.', 'Do not ask to change or clear the stored value.', 'Use one message for recall, then stop after the answer.'] } },
  { id: 'sim-b', input: store, reference: { benchmark: 'acceptance-v2-native', simulated: true, expectedReplies: ['STORED', 'UPDATED', '__TRIAL_UPDATE__'] }, conversation: { mode: 'simulated', provider: provider(models[1]), maxTurns: 5,
    goal: 'After the assistant acknowledges storing a value, ask it to replace the current value with the exact literal __TRIAL_UPDATE__ and reply exactly UPDATED with no punctuation. After its update acknowledgment, ask it to recall the current value and return only the value. Stop after it returns a token beginning CANARY_ and ending _UPDATED. If it does something unexpected, stop and explain it; do not repair the conversation.', facts: { replacementLiteral: '__TRIAL_UPDATE__' }, constraints: ['Do not reveal or invent the original stored value.', 'The replacement literal must include both leading and trailing double underscores.', 'Exactly one replacement request, then one recall request, then stop.'] } },
];
await save('simulated-cases.json', simulated);
await save('simulated-eval.json', { version: 1, name: 'Real model simulated-user native HTTP acceptance', cases: './simulated-cases.json', target: target('simulated-audit.jsonl'), files: [...targetFiles, providerFile], execution: { repeats: 2, concurrency: 1, timeoutMs: 240000 } });
await save('provenance.json', { preparedAt: new Date().toISOString(), author: 'Evaluation agent', humanAnnotated: false, judgeModelIds: models, labelsFrozenBeforeCalls: true, goldSha256: createHash('sha256').update(await readFile(path.join(output, 'gold.json'))).digest('hex'), casesSha256: createHash('sha256').update(await readFile(path.join(output, 'cases.json'))).digest('hex'), gradingCalls: 96, nativeTrials: 15, nativeTurns: 30, simulatedTrials: 4, simulatedExpectedCalls: 20, simulatedWorstCaseCalls: 32, hardInvocationLimit: 180, plannedExpectedCalls: 146, phasesRunSequentially: true });
console.log(JSON.stringify({ output, evidence, fixtureCount: cases.length, expectedCalls: 146, hardLimit: 180 }));
