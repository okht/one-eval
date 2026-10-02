import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { hash, latestArtifacts, listArtifacts, readManifest, writeArtifact, writeJson } from '../src/storage.js';
import { buildReport } from '../src/report.js';
import { compareRuns } from '../src/compare.js';
import { analyzeReport, weightedMean } from '../src/report-analysis.js';
import type { GradeRecord, PreparedGrading, RunManifest, TrialArtifact } from '../src/types.js';

async function fixture(weights = [1, 3], scores = [1, 0], judgeWeights = [1]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-persistence-'));
  const createdAt = '2026-10-02T00:00:00Z';
  const plan: RunManifest['prepared']['plan'] = {
    version: 1, name: 'Persistence invariant',
    cases: weights.map((weight, i) => ({ id: `c${i}`, input: `Question ${i}`, reference: 'Answer', weight, metadata: { category: 'all' } })),
    target: { kind: 'module', path: path.join(directory, 'not-invoked.mjs'), retrySafe: false, isolation: { mode: 'stateless', scope: 'independent', evidence: 'Imported test records' } },
    execution: { repeats: 1, concurrency: 1, timeoutMs: 1000 },
  };
  const manifest: RunManifest = { version: 1, runId: randomUUID(), createdAt, prepared: { plan, files: [], baseDir: directory, planHash: hash({ plan, files: [] }) }, engine: { name: 'promptfoo', version: '0.123.1' } };
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  await writeJson(path.join(directory, 'state.json'), { blocked: false, updatedAt: createdAt });
  const gradingPlan: PreparedGrading['plan'] = { version: 1, concurrency: 1, timeoutMs: 1000, judges: judgeWeights.map((weight, i) => ({ id: `j${i}`, kind: 'command', command: 'never-invoked', repeats: 1, weight })) };
  const grading: PreparedGrading = { plan: gradingPlan, files: [], baseDir: directory, versionHash: hash({ plan: gradingPlan, files: [] }) };
  await writeJson(path.join(directory, 'grades', grading.versionHash, 'manifest.json'), { version: 1, runId: manifest.runId, createdAt, prepared: grading });
  await writeJson(path.join(directory, 'grades', grading.versionHash, 'state.json'), { blocked: false, updatedAt: createdAt });
  const artifacts: TrialArtifact[] = [];
  const records: GradeRecord[] = [];
  for (const [i, item] of plan.cases.entries()) {
    const artifact: TrialArtifact = { version: 1, runId: manifest.runId, trialId: hash({ runId: manifest.runId, caseId: item.id, repeat: 0 }), caseId: item.id, repeat: 0, attempt: 1, sessionId: randomUUID(), startedAt: createdAt, finishedAt: createdAt, status: 'completed', messages: [{ role: 'user', content: item.input }, { role: 'assistant', content: 'Answer' }], output: 'Answer' };
    artifact.outputHash = hash({ output: artifact.output, messages: artifact.messages, metadata: artifact.metadata });
    await writeArtifact(directory, artifact);
    await writeJson(path.join(directory, 'attempts', `${hash(artifact.trialId)}-1.json`), { ...artifact, status: 'running', finishedAt: undefined, output: undefined, outputHash: undefined, messages: [] });
    artifacts.push(artifact);
    for (const judge of gradingPlan.judges) {
      const identity = { runId: manifest.runId, trialId: artifact.trialId, executionAttempt: 1, outputHash: artifact.outputHash!, gradingVersion: grading.versionHash, judgeId: judge.id, repeat: 0, attempt: 1 };
      const record: GradeRecord = { version: 1, id: hash(identity), ...identity, caseId: item.id, status: 'scored', score: scores[i]!, reason: 'Fixed test reference', createdAt };
      await writeJson(path.join(directory, 'grades', grading.versionHash, 'records', `${record.id}.json`), record);
      records.push(record);
    }
  }
  return { directory, manifest, grading, artifacts, records };
}

async function cannotComplete(directory: string) {
  try { const report = await buildReport(directory); assert.equal(report.complete, false); assert.equal(report.overall, null); }
  catch (error) { if (error instanceof assert.AssertionError) throw error; }
}

test('duplicate artifact files cannot silently disappear behind latest-attempt selection', async () => {
  const f = await fixture();
  const file = path.join(f.directory, 'artifacts', `${hash(f.artifacts[0]!.trialId)}-1.json`);
  await copyFile(file, path.join(f.directory, 'artifacts', 'duplicate.json'));
  await assert.rejects(listArtifacts(f.directory), /artifact|identity|filename/i);
  await cannotComplete(f.directory);
});

test('conflicting same-attempt records are rejected regardless of array order', async () => {
  const f = await fixture();
  const a = f.artifacts[0]!;
  const changed = { ...a, status: 'execution_error' as const, error: 'Contradiction' };
  for (const order of [[a, changed], [changed, a]]) assert.throws(() => latestArtifacts(order), /conflict|duplicate/i);
});

test('a newer started execution with no artifact cannot reuse a previously complete score', async () => {
  const f = await fixture();
  const previous = f.artifacts[0]!;
  await writeJson(path.join(f.directory, 'attempts', `${hash(previous.trialId)}-2.json`), { ...previous, attempt: 2, status: 'running', sessionId: randomUUID(), messages: [], output: undefined, outputHash: undefined, finishedAt: undefined });
  const before = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  await cannotComplete(f.directory);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), before, 'Reporting must stay read-only');
});

test('a mismatched execution ticket cannot certify an otherwise complete artifact', async () => {
  const f = await fixture();
  const a = f.artifacts[0]!;
  await writeJson(path.join(f.directory, 'attempts', `${hash(a.trialId)}-1.json`), { ...a, status: 'running', caseId: 'other-case' });
  await cannotComplete(f.directory);
});

test('partially deleted execution ledgers cannot claim complete retained evidence', async () => {
  const f = await fixture();
  await unlink(path.join(f.directory, 'attempts', `${hash(f.artifacts[0]!.trialId)}-1.json`));
  await cannotComplete(f.directory);
});

test('separate trials cannot share the same runner session identity', async () => {
  const f = await fixture();
  const changed = { ...f.artifacts[1]!, sessionId: f.artifacts[0]!.sessionId };
  await writeJson(path.join(f.directory, 'artifacts', `${hash(changed.trialId)}-1.json`), changed);
  await writeJson(path.join(f.directory, 'attempts', `${hash(changed.trialId)}-1.json`), { ...changed, status: 'running' });
  await cannotComplete(f.directory);
});

test('unfinished newer grading reservations cannot be hidden by an earlier score', async () => {
  const f = await fixture();
  const r = f.records[0]!;
  const identity = { runId: r.runId, trialId: r.trialId, executionAttempt: r.executionAttempt, outputHash: r.outputHash, gradingVersion: r.gradingVersion, judgeId: r.judgeId, repeat: r.repeat, attempt: 2 };
  const reservation = { version: 1, id: hash(identity), ...identity, caseId: r.caseId, createdAt: r.createdAt };
  await writeJson(path.join(f.directory, 'grades', f.grading.versionHash, 'attempts', `${reservation.id}.json`), reservation);
  await cannotComplete(f.directory);
});

test('running artifact updates cannot rewrite their original identity', async () => {
  const f = await fixture();
  const artifact = { ...f.artifacts[0]!, trialId: 'running-test', status: 'running' as const };
  await writeArtifact(f.directory, artifact);
  await assert.rejects(writeArtifact(f.directory, { ...artifact, runId: 'changed-run', status: 'execution_error' }), /identity|immutable/i);
});

test('foreign and orphan grade records cannot leave a report complete', async () => {
  const f = await fixture();
  const r = f.records[0]!;
  const identity = { runId: r.runId, trialId: r.trialId, executionAttempt: r.executionAttempt, outputHash: r.outputHash, gradingVersion: r.gradingVersion, judgeId: 'unconfigured-judge', repeat: 0, attempt: 1 };
  const extra = { ...r, ...identity, id: hash(identity) };
  await writeJson(path.join(f.directory, 'grades', f.grading.versionHash, 'records', `${extra.id}.json`), extra);
  await cannotComplete(f.directory);
});

test('a completed output hash cannot override failed isolation or cleanup evidence', async () => {
  for (const contradiction of [
    { isolation: { ok: false, evidence: 'Previous session was reused' } },
    { cleanupError: 'Database reset failed' },
    { error: 'Remote execution outcome is unknown' },
  ]) {
    const f = await fixture();
    const artifact = { ...f.artifacts[0]!, ...contradiction };
    await writeJson(path.join(f.directory, 'artifacts', `${hash(artifact.trialId)}-1.json`), artifact);
    await cannotComplete(f.directory);
  }
});

test('persisted plan weights and repeat counts are validated even when its hash matches', async () => {
  for (const mutate of [
    (m: RunManifest) => { m.prepared.plan.cases[0]!.weight = 0; },
    (m: RunManifest) => { m.prepared.plan.execution.repeats = -1; },
    (m: RunManifest) => { m.prepared.plan.cases[1]!.id = m.prepared.plan.cases[0]!.id; },
  ]) {
    const f = await fixture(); mutate(f.manifest);
    f.manifest.prepared.planHash = hash({ plan: f.manifest.prepared.plan, files: f.manifest.prepared.files });
    await writeJson(path.join(f.directory, 'manifest.json'), f.manifest);
    await assert.rejects(readManifest(f.directory), /manifest|plan|weight|repeat|case/i);
  }
});

test('valid extreme finite weights preserve convex weighted scores at case and judge levels', async () => {
  const f = await fixture([1e308, 1e308], [1, 0], [1e308, 1e308]);
  const report = await buildReport(f.directory);
  assert.equal(report.complete, true);
  assert.equal(report.overall, 0.5);
  assert.equal(report.analysis.groups[0]?.score, 0.5);
  assert.ok(report.cases.every(item => item.score === 0 || item.score === 1));
});

test('blocked runs do not publish per-case comparison improvements or regressions', async () => {
  const baseline = await fixture([1], [0]);
  const candidate = await fixture([1], [1]);
  await writeJson(path.join(candidate.directory, 'state.json'), { blocked: true, reason: 'Cleanup uncertain', updatedAt: 'now' });
  const result = await compareRuns(baseline.directory, candidate.directory);
  assert.equal(result.comparable, false);
  assert.equal(result.improvements, 0);
  assert.equal(result.regressions, 0);
  assert.ok(result.cases.every(item => item.delta === null));
});

test('prototype-like metric keys remain ordinary JSON fields without modifying Object.prototype', () => {
  const calls = JSON.parse('[{"tokenUsage":{"__proto__":7,"constructor":3,"input":2}}]');
  const artifact = { attempt: 1, status: 'completed', metadata: { target: { calls } } } as unknown as TrialArtifact;
  const usage = analyzeReport([], [artifact], [], 1, false).usage.target;
  assert.equal(Object.hasOwn(usage.tokens, '__proto__'), true);
  assert.equal(usage.tokens['__proto__']?.knownTotal, 7);
  assert.equal(usage.tokens['constructor']?.knownTotal, 3);
  assert.equal(Object.hasOwn(Object.prototype, 'knownTotal'), false);
});

test('overflowing usage sums are explicitly marked instead of serialized as ordinary null totals', () => {
  const artifact = { attempt: 1, status: 'completed', metadata: { target: { calls: [{ cost: 1e308, tokenUsage: { input: 1e308 } }, { cost: 1e308, tokenUsage: { input: 1e308 } }] } } } as unknown as TrialArtifact;
  const usage = analyzeReport([], [artifact], [], 1, false).usage.target;
  assert.equal(usage.cost.knownTotal, null);
  assert.equal((usage.cost as any).overflow, true);
  assert.equal(usage.tokens.input?.knownTotal, null);
  assert.equal((usage.tokens.input as any).overflow, true);
});

test('group weighted-score invariants hold under permutations and extreme rescalings', () => {
  const weights = [1e-300, 1, 1e300, 1e308];
  for (const weight of weights) for (const reverse of [false, true]) {
    const cases = [0.2, 0.8, 0.5].map((score, i) => ({ caseId: String(i), weight, complete: true, score, metadata: { category: 'group' }, executions: [] }));
    if (reverse) cases.reverse();
    const actual = analyzeReport(cases, [], [], 3, false).groups[0]!.score;
    assert.ok(typeof actual === 'number' && Number.isFinite(actual));
    assert.ok(Math.abs(actual! - 0.5) < 1e-12);
  }
});

test('the smallest positive finite weights do not underflow a weighted score', () => {
  assert.equal(weightedMean([{ score: 0.5, weight: Number.MIN_VALUE }, { score: 0.5, weight: Number.MIN_VALUE }]), 0.5);
});
