import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareGrading, preparePlan } from '../src/config.js';
import { calibrateGrading, probeExecution } from '../src/preflight.js';
import { fileHash, hash, listArtifacts, readJson, readManifest, readRunState, writeJson } from '../src/storage.js';
import { readGradeRecords } from '../src/grading.js';
import type { CalibrationFixtures } from '../src/preflight.js';

async function executionFixture(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-probe-'));
  const modulePath = path.join(directory, 'adapter.mjs');
  await copyFile(path.resolve('tests/fixtures/lifecycle.mjs'), modulePath);
  const log = path.join(directory, 'calls.jsonl');
  const config = path.join(directory, 'eval.json');
  await writeJson(config, {
    version: 1, name: 'Real execution probe', cases: [{ id: 'a', input: 'First' }, { id: 'b', input: 'Second' }, { id: 'c', input: 'Third' }],
    target: { kind: 'module', path: modulePath, config: { log, ...options }, isolation: { mode: 'managed', scope: 'shared', evidence: 'Fixture state resets on prepare' }, retrySafe: true },
    execution: { repeats: 3, concurrency: 1, timeoutMs: 3000 },
  });
  return { directory, config, log, readLog: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

const fixtureDocument = (): CalibrationFixtures => ({ version: 1, fixtures: [
  { id: 'a', label: 'positive', input: '2 + 2?', reference: '4', output: '4', expected: { status: 'scored', minScore: 1, maxScore: 1 } },
  { id: 'b', label: 'negative', input: '2 + 2?', reference: '4', output: '5', expected: { status: 'scored', minScore: 0, maxScore: 0 } },
  { id: 'c', label: 'edge', input: '2 + 2?', reference: '4', output: '', expected: { status: 'insufficient_evidence' } },
] });

async function calibrationFixture(body?: string, repeats = 2, judges = 2) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-calibration-'));
  const script = path.join(directory, 'grader.mjs');
  await writeFile(script, `import fs from 'node:fs'; const input=JSON.parse(fs.readFileSync(0,'utf8'));
    if ('expected' in input || 'expected' in input.case || 'label' in input.case || 'label' in input.artifact.metadata) throw new Error('Expectation leaked');
    if (input.artifact.metadata.oneEvalProvenance.targetInvoked!==false) throw new Error('Provenance missing');
    ${body ?? `const result = input.artifact.output === '' ? {status:'insufficient_evidence',reason:'No saved answer'} : {status:'scored',score:Number(input.artifact.output===input.case.reference),reason:'Checked reference'};
    console.log(JSON.stringify(result));`}
  `);
  const config = path.join(directory, 'judges.json');
  await writeJson(config, {
    version: 1, judges: Array.from({ length: judges }, (_, i) => ({ id: `judge-${i}`, kind: 'command', command: process.execPath, args: [script], repeats })), concurrency: 1, timeoutMs: 3000,
  });
  const fixtures = path.join(directory, 'fixtures.json');
  await writeJson(fixtures, fixtureDocument());
  return { directory, config, fixtures, output: path.join(directory, 'calibration'), prepared: await prepareGrading(config) };
}

test('execution probe runs a bounded subset without judges or modifying the original plan', async () => {
  const f = await executionFixture();
  const prepared = await preparePlan(f.config);
  const original = hash(prepared);
  const output = path.join(f.directory, 'probe');
  const result = await probeExecution(prepared, output);
  assert.equal(result.ok, true);
  assert.equal(result.sourcePlanHash, prepared.planHash);
  assert.notEqual(result.probePlanHash, prepared.planHash);
  assert.deepEqual(result.caseIds, ['a', 'b']);
  assert.equal(result.summary?.planned, 2);
  assert.equal(result.summary?.completed, 2);
  assert.equal(result.isolation.basis, 'adapter_verification');
  assert.match(result.isolation.limits.join(' '), /does not certify/);
  assert.equal(hash(prepared), original);
  assert.equal((await f.readLog()).filter(x => x.event === 'execute').length, 2);
  assert.equal((await listArtifacts(output)).length, 2);
  assert.deepEqual(await readJson(path.join(output, 'preflight.json')), JSON.parse(JSON.stringify(result)));
  assert.equal((await readdir(output)).includes('grades'), false);
});

test('failed isolation blocks probe execution and keeps failure evidence', async () => {
  const f = await executionFixture({ verify: false });
  const result = await probeExecution(await preparePlan(f.config), path.join(f.directory, 'probe'));
  assert.equal(result.ok, false);
  assert.equal(result.summary?.blocked, true);
  assert.equal(result.summary?.pending, 1);
  assert.equal(result.checks.find(item => item.name === 'isolation_verification')?.ok, false);
  assert.equal((await f.readLog()).filter(x => x.event === 'execute').length, 0);
  assert.equal((await listArtifacts(result.directory))[0]?.status, 'isolation_error');
});

test('probes refuse existing output directories, tampered plans, and unbounded case/turn limits before calls', async () => {
  const f = await executionFixture();
  const prepared = await preparePlan(f.config);
  await assert.rejects(probeExecution(prepared, f.directory), /already exists/);
  await assert.rejects(probeExecution(prepared, path.join(f.directory, 'bad-limit'), { caseLimit: 11 }), /1 to 10/);
  const modified = structuredClone(prepared);
  modified.plan.execution.repeats = 4;
  await assert.rejects(probeExecution(modified, path.join(f.directory, 'tampered')), /hash/);
  modified.plan.cases[0]!.conversation = { mode: 'scripted', turns: Array(31).fill('More') };
  modified.planHash = hash({ plan: modified.plan, files: modified.files });
  await assert.rejects(probeExecution(modified, path.join(f.directory, 'long')), /30 target turns/);
  await assert.rejects(readFile(f.log), { code: 'ENOENT' });
});

test('calibration checks every judge repeat against imported fixtures without loading a target', async () => {
  const f = await calibrationFixture();
  const originalConfigHash = await fileHash(f.config);
  const result = await calibrateGrading(f.prepared, f.fixtures, f.output);
  assert.equal(result.ok, true);
  assert.equal(result.planned, 12);
  assert.equal(result.matched, 12);
  assert.equal(result.errors, 0);
  assert.equal(result.missing, 0);
  assert.equal(await fileHash(f.config), originalConfigHash);
  const manifest = await readManifest(f.output);
  assert.match(await readFile(manifest.prepared.plan.target.path!, 'utf8'), /throw new Error/);
  assert.equal((await readRunState(f.output)).blocked, true);
  assert.equal((await listArtifacts(f.output)).every(item => item.sessionId.startsWith('imported-fixture:')), true);
  assert.equal((await readGradeRecords(f.output, f.prepared.versionHash)).length, 12);
  assert.deepEqual(await readJson(path.join(f.output, 'calibration.json')), result);
  assert.equal((await readdir(f.output)).includes('attempts'), false);
});

test('a grader returning full marks for every answer fails negative and missing-evidence fixtures', async () => {
  const f = await calibrationFixture(`console.log(JSON.stringify({status:'scored',score:1,reason:'Always passes'}));`, 1, 1);
  const result = await calibrateGrading(f.prepared, f.fixtures, f.output);
  assert.equal(result.ok, false);
  assert.equal(result.matched, 1);
  assert.equal(result.mismatched, 2);
  assert.equal(result.errors, 0);
  assert.equal(result.results.find(item => item.fixtureId === 'b')?.actual?.score, 1);
});

test('one disagreeing repeat fails calibration even if the mean lies inside the interval', async () => {
  const f = await calibrationFixture(`const result=input.case.id==='a'?{status:'scored',score:input.repeat===0?0.5:1,reason:'Unstable'}:input.case.id==='b'?{status:'scored',score:0,reason:'Wrong answer'}:{status:'insufficient_evidence',reason:'No answer'};console.log(JSON.stringify(result));`, 2, 1);
  const document = fixtureDocument();
  document.fixtures[0]!.expected = { status: 'scored', minScore: 0.7, maxScore: 1 };
  await writeJson(f.fixtures, document);
  const result = await calibrateGrading(f.prepared, f.fixtures, f.output);
  assert.equal(result.ok, false);
  assert.equal(result.mismatched, 1);
  assert.equal(result.matched, 5);
});

test('grader failures remain errors without zero scores and preserve all failed records', async () => {
  const f = await calibrationFixture(`console.error('transport disconnected');process.exit(1);`, 1, 1);
  const result = await calibrateGrading(f.prepared, f.fixtures, f.output);
  assert.equal(result.ok, false);
  assert.equal(result.errors, 3);
  assert.equal(result.mismatched, 0);
  assert.equal(result.missing, 0);
  assert.ok(result.results.every(item => item.actual?.status === 'grading_error' && item.actual.score === undefined));
  assert.equal((await readGradeRecords(f.output, f.prepared.versionHash)).length, 3);
});

test('systemic grader failures keep missing slots explicit and stop later calls', async () => {
  const f = await calibrationFixture(`console.error('401 Unauthorized');process.exit(1);`, 2, 1);
  const result = await calibrateGrading(f.prepared, f.fixtures, f.output);
  assert.equal(result.ok, false);
  assert.equal(result.errors, 1);
  assert.equal(result.missing, 5);
  assert.equal((await readGradeRecords(f.output, f.prepared.versionHash)).length, 1);
});

test('calibration rejects missing/overlapping anchors and inconsistent transcript evidence before grading', async () => {
  const f = await calibrationFixture();
  const document = fixtureDocument();
  document.fixtures[1]!.label = 'edge';
  await writeJson(f.fixtures, document);
  await assert.rejects(calibrateGrading(f.prepared, f.fixtures, f.output), /positive and negative/);
  document.fixtures[1]!.label = 'negative';
  document.fixtures[1]!.expected = { status: 'scored', minScore: 0, maxScore: 1 };
  await writeJson(f.fixtures, document);
  await assert.rejects(calibrateGrading(f.prepared, f.fixtures, f.output), /must not overlap/);
  document.fixtures[1]!.expected = { status: 'scored', minScore: 0, maxScore: 0 };
  document.fixtures[0]!.messages = [{ role: 'user', content: '2 + 2?' }, { role: 'assistant', content: 'Changed answer' }];
  await writeJson(f.fixtures, document);
  await assert.rejects(calibrateGrading(f.prepared, f.fixtures, f.output), /saved assistant output/);
  await assert.rejects(readdir(f.output), { code: 'ENOENT' });
});

test('calibration refuses existing output directories without changing their files', async () => {
  const f = await calibrationFixture();
  await calibrateGrading(f.prepared, f.fixtures, f.output);
  const before = await readFile(path.join(f.output, 'calibration.json'), 'utf8');
  await assert.rejects(calibrateGrading(f.prepared, f.fixtures, f.output), /already exists/);
  assert.equal(await readFile(path.join(f.output, 'calibration.json'), 'utf8'), before);
});
