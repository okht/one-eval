import assert from 'node:assert/strict';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const evidence = path.resolve(process.argv[2]);
const nativeDirectory = path.resolve(process.argv[3]);
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const calibration = await read(path.join(evidence, 'calibration.json'));
let nativeFile = path.join(evidence, 'native.json');
try { await access(path.join(evidence, 'native-retry.json')); nativeFile = path.join(evidence, 'native-retry.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const native = await read(nativeFile);
const records = await Promise.all((await readdir(path.join(evidence, 'calls'))).filter(name => name.endsWith('.result.json')).map(name => read(path.join(evidence, 'calls', name))));
let semantic, semanticCalls = [];
try {
  semantic = await read(path.join(evidence, 'semantic-calibration.json'));
  semanticCalls = await Promise.all((await readdir(path.join(evidence, 'semantic-calls'))).filter(name => name.endsWith('.result.json')).map(name => read(path.join(evidence, 'semantic-calls', name))));
  assert.equal(semanticCalls.length, semantic.planned);
  assert.equal((await readdir(path.join(evidence, 'semantic-calls'))).filter(name => name.endsWith('.start.json')).length, semanticCalls.length);
  assert.ok(semanticCalls.every(item => item.status === 'completed' && item.ephemeral && item.expectedThreadId === null));
  assert.equal(new Set(semanticCalls.map(item => item.threadId)).size, semanticCalls.length);
  for (const call of semanticCalls) {
    const input = JSON.parse(call.prompt.slice(call.prompt.lastIndexOf('\n\nUSER\n') + 7));
    assert.equal(input.expected, undefined); assert.equal(input.label, undefined); assert.equal(input.case.expected, undefined); assert.equal(input.case.label, undefined);
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const allCalls = [...records, ...semanticCalls];
const starts = (await readdir(path.join(evidence, 'calls'))).filter(name => name.endsWith('.start.json')).length;
assert.equal(starts, records.length, 'Every started CLI call requires a terminal evidence record');
const judgeCalls = records.filter(item => item.ephemeral && item.prompt.startsWith('SYSTEM\n'));
assert.equal(judgeCalls.length, calibration.planned);
assert.ok(judgeCalls.every(item => item.status === 'completed' && item.expectedThreadId === null));
assert.equal(new Set(judgeCalls.map(item => item.threadId)).size, judgeCalls.length, 'Each judge invocation requires a fresh native thread');
const judgeSlots = new Set();
for (const call of judgeCalls) {
  const input = JSON.parse(call.prompt.slice(call.prompt.lastIndexOf('\n\nUSER\n') + 7));
  assert.equal(input.expected, undefined); assert.equal(input.label, undefined);
  assert.equal(input.case.label, undefined); assert.equal(input.case.expected, undefined);
  const slot = `${input.case.id}:${input.judgeId}:${input.repeat}`;
  assert.ok(!judgeSlots.has(slot), `Judge slot called more than once: ${slot}`); judgeSlots.add(slot);
}
const audit = (await readFile(path.join(evidence, 'service-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const created = audit.filter(event => event.type === 'session.created');
const deleted = audit.filter(event => event.type === 'session.deleted');
const turns = audit.filter(event => event.type === 'turn.completed');
assert.equal(deleted.length, created.length);
assert.equal(new Set(created.map(event => event.sessionId)).size, created.length);
assert.equal(new Set(deleted.filter(event => event.threadId).map(event => event.threadId)).size, deleted.filter(event => event.threadId).length);
for (const session of created) {
  assert.equal(deleted.filter(event => event.sessionId === session.sessionId && event.directoryRemoved).length, 1);
  assert.ok(new Set(turns.filter(event => event.sessionId === session.sessionId).map(event => event.threadId)).size <= 1);
  let exists = true; try { await access(session.directory); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  assert.equal(exists, false, `Owned working directory still exists: ${session.directory}`);
}
assert.ok(audit.some(event => event.type === 'service.closed' && event.activeSessions === 0));
assert.ok(turns.every(event => event.transport === 'latest_message_only'));
const allArtifacts = await Promise.all((await readdir(path.join(nativeDirectory, 'artifacts'))).map(name => read(path.join(nativeDirectory, 'artifacts', name))));
const latest = new Map();
for (const item of allArtifacts) if (!latest.has(item.trialId) || latest.get(item.trialId).attempt < item.attempt) latest.set(item.trialId, item);
const artifacts = [...latest.values()];
assert.equal(artifacts.length, 12); assert.ok(artifacts.every(item => item.status === 'completed' && item.isolation?.ok));
const finalTurnCalls = artifacts.flatMap(item => item.metadata.target.calls.map(call => call.metadata));
assert.equal(finalTurnCalls.length, 22);
assert.equal(new Set(finalTurnCalls.map(item => item.nativeThreadId)).size, 12);
const byModel = Object.fromEntries([...new Set(calibration.results.map(item => item.judgeId))].map(model => {
  const rows = calibration.results.filter(item => item.judgeId === model);
  return [model, { planned: rows.length, matched: rows.filter(item => item.status === 'matched').length, mismatches: rows.filter(item => item.status === 'mismatched'), errors: rows.filter(item => item.status === 'grading_error').length }];
}));
const pairs = new Map();
for (const result of calibration.results) {
  const key = `${result.fixtureId}:${result.repeat}`;
  if (!pairs.has(key)) pairs.set(key, []);
  pairs.get(key).push(result.actual ? { status: result.actual.status, score: result.actual.score ?? null } : null);
}
const pairwiseAgreement = [...pairs.values()].filter(values => values.length === 2 && JSON.stringify(values[0]) === JSON.stringify(values[1])).length;
const nativeFailures = native.report.cases.flatMap(item => item.executions.filter(execution => execution.score !== 1).map(execution => ({ caseId: item.caseId, repeat: execution.repeat, score: execution.score, judges: execution.judges })));
const blank = artifacts.filter(item => item.caseId.includes('blank'));
const graded = calibration.results.filter(item => item.actual?.status === 'scored');
const summary = {
  generatedAt: new Date().toISOString(),
  calls: { total: allCalls.length, completed: allCalls.filter(item => item.status === 'completed').length, failed: allCalls.filter(item => item.status !== 'completed').length, byRequestedModel: Object.fromEntries([...new Set(allCalls.map(item => item.requestedModel))].map(model => [model, allCalls.filter(item => item.requestedModel === model).length])) },
  grading: { ok: calibration.ok, fixtures: new Set(calibration.results.map(item => item.fixtureId)).size, calls: calibration.planned, uniqueFreshThreads: new Set(judgeCalls.map(item => item.threadId)).size, calibrationLabelsWithheld: true, matched: calibration.matched, mismatched: calibration.mismatched, errors: calibration.errors, missing: calibration.missing, scored: graded.length, insufficientEvidence: calibration.results.filter(item => item.actual?.status === 'insufficient_evidence').length, byModel, pairwiseAgreement: { agreed: pairwiseAgreement, compared: pairs.size }, gradingVersion: calibration.gradingVersion },
  ...(semantic ? { semanticGrading: { ok: semantic.ok, fixtures: 3, calls: semantic.planned, matched: semantic.matched, errors: semantic.errors, missing: semantic.missing, uniqueFreshThreads: new Set(semanticCalls.map(item => item.threadId)).size, calibrationLabelsWithheld: true, agentAuthored: true, humanAnnotated: false, fixedScores: [1, 0, 0.5], gradingVersion: semantic.gradingVersion } } : {}),
  nativeHttp: { complete: native.report.complete, overall: native.report.overall, trials: artifacts.length, successfulFinalModelTurns: finalTurnCalls.length, successfulAllAttemptTurns: turns.length, nativeResumeTurns: finalTurnCalls.filter(item => item.nativeResume).length, uniqueFinalThreads: new Set(finalTurnCalls.map(item => item.nativeThreadId)).size, totalSessionAttempts: created.length, successfulCleanup: deleted.length, firstAttemptExecutionErrors: allArtifacts.filter(item => item.attempt === 1 && item.status !== 'completed').map(item => ({ trialId: item.trialId, caseId: item.caseId, repeat: item.repeat, error: item.error })), blankProbes: blank.length, blankUnknown: blank.filter(item => item.output.trim() === 'UNKNOWN').length, failures: nativeFailures, gradingVersion: native.report.gradingVersion, nativeHistoryRetained: true },
  evidence: { calibration: path.relative(root, path.join(evidence, 'calibration.json')), ...(semantic ? { semanticCalibration: path.relative(root, path.join(evidence, 'semantic-calibration.json')), semanticCalls: path.relative(root, path.join(evidence, 'semantic-calls')) } : {}), native: path.relative(root, nativeFile), serviceAudit: path.relative(root, path.join(evidence, 'service-audit.jsonl')), calls: path.relative(root, path.join(evidence, 'calls')) },
  limitations: ['Small known-answer calibration; does not establish general semantic or business-rubric judge accuracy.', 'Both requested judge models are from one provider family; this is not a cross-vendor bias study.', 'Local real-model-backed loopback HTTP with native Codex resume; not a production remote API certification.', 'Service session capabilities and temporary directories are deleted. Codex native history remains for audit.', 'Requested model IDs are recorded and accepted by the pinned CLI; ephemeral judge responses do not expose an independent server model identifier.'],
};
await writeFile(path.join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
