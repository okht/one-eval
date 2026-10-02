import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFile, copyFile, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareGrading, preparePlan } from '../src/config.js';
import { runEvaluation, resumeEvaluation, recoverEvaluation } from '../src/execution.js';
import { gradeEvaluation } from '../src/grading.js';
import { calibrateGrading, probeExecution } from '../src/preflight.js';
import { ADMISSION_TTL_MS } from '../src/admission.js';
import { buildReport } from '../src/report.js';
import { fileHash, hash, readJson, readManifest, writeJson } from '../src/storage.js';

async function setup(options: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'one-eval-admission-'));
  const module = path.join(root, 'adapter.mjs');
  await copyFile(path.resolve('tests/fixtures/lifecycle.mjs'), module);
  const log = path.join(root, 'target.jsonl');
  const config = path.join(root, 'eval.json');
  await writeJson(config, {
    version: 1, name: 'Admission fixture', cases: [{ id: 'a', input: 'Question', reference: 'a:1' }, { id: 'b', input: 'Question', reference: 'b:1' }],
    target: { kind: 'module', path: module, config: { log, ...options }, retrySafe: true,
      isolation: { mode: 'managed', scope: 'independent', evidence: 'Session map resets on prepare' } },
    execution: { repeats: 2, concurrency: 1, timeoutMs: 3000 },
  });
  const grader = path.join(root, 'grader.mjs');
  const judgeLog = path.join(root, 'judges.jsonl');
  await writeFile(grader, `import fs from 'node:fs'; const input=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(judgeLog)},'called\\n');console.log(JSON.stringify({status:'scored',score:Number(input.artifact.output===input.case.reference),reason:'Reference comparison'}));`);
  const judges = path.join(root, 'judges.json');
  await writeJson(judges, { version: 1, judges: [{ id: 'judge', kind: 'command', command: process.execPath, args: [grader], repeats: 2 }], concurrency: 1, timeoutMs: 3000 });
  const fixtures = path.join(root, 'fixtures.json');
  await writeJson(fixtures, { version: 1, fixtures: [
    { id: 'positive', label: 'positive', input: 'Q', reference: 'yes', output: 'yes', expected: { status: 'scored', minScore: 1, maxScore: 1 } },
    { id: 'negative', label: 'negative', input: 'Q', reference: 'yes', output: 'no', expected: { status: 'scored', minScore: 0, maxScore: 0 } },
  ] });
  const count = async (file: string) => { try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  return { root, module, config, grader, judges, fixtures, prepared: await preparePlan(config), grading: await prepareGrading(judges),
    targetCalls: () => count(log), judgeCalls: () => count(judgeLog), run: path.join(root, 'run'), probe: path.join(root, 'probe'), calibration: path.join(root, 'calibration') };
}
const formal = (receipt?: string) => ({ mode: 'formal', ...(receipt ? { receipt } : {}) }) as any;

async function blockedFormal(options: Record<string, unknown> = {}) {
  const f = await setup(options);
  const control = path.join(f.root, 'cleanup-control.txt');
  await writeFile(control, 'ok');
  const config = await readJson<any>(f.config);
  config.target.config.cleanupControl = control;
  await writeJson(f.config, config);
  await writeFile(f.module, (await readFile(f.module, 'utf8')).replace('async recover(context) {', "async recover(context) { await log('recover',context);"));
  const prepared = await preparePlan(f.config);
  await probeExecution(prepared, f.probe);
  await writeFile(control, 'fail');
  assert.equal((await runEvaluation(prepared, f.run, formal(path.join(f.probe, 'admission.json')))).blocked, true);
  return { ...f, prepared, control };
}

test('formal execution and grading refuse missing admission before any external calls', async () => {
  const f = await setup();
  await assert.rejects(runEvaluation(f.prepared, f.run, formal()), /receipt/i);
  assert.equal(await f.targetCalls(), 0);
  await runEvaluation(f.prepared, f.run);
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal()), /receipt/i);
  assert.equal(await f.judgeCalls(), 0);
});

test('successful independent gates retain formal mode and still verify every target trial', async () => {
  const f = await setup();
  const probe = await probeExecution(f.prepared, f.probe);
  assert.equal(probe.ok, true);
  const result = await runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json')));
  assert.equal((result as any).mode, 'formal');
  assert.equal((await readManifest(f.run) as any).admission.mode, 'formal');
  assert.equal(await f.targetCalls(), 24); // Two probe trials + four formal trials, four lifecycle calls each.
  const calibration = await calibrateGrading(f.grading, f.fixtures, f.calibration);
  assert.equal(calibration.ok, true);
  const graded = await gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json'))) as any;
  assert.equal(graded.mode, 'formal');
  assert.equal(await f.judgeCalls(), 12);
  await resumeEvaluation(f.run);
  await gradeEvaluation(f.run, f.grading);
  assert.equal(await f.targetCalls(), 24);
  assert.equal(await f.judgeCalls(), 12);
});

test('failed probe cannot be admitted by flipping the summary ok flag', async () => {
  const f = await setup({ verify: false });
  const probe = await probeExecution(f.prepared, f.probe);
  assert.equal(probe.ok, false);
  await writeJson(path.join(f.probe, 'preflight.json'), { ...probe, ok: true });
  const before = await f.targetCalls();
  await assert.rejects(runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json'))));
  assert.equal(await f.targetCalls(), before);
});

test('changed plan or declared source cannot reuse a successful execution receipt', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  const changed = structuredClone(f.prepared);
  changed.plan.cases[0]!.input = 'Changed question';
  changed.planHash = hash({ plan: changed.plan, files: changed.files });
  const before = await f.targetCalls();
  await assert.rejects(runEvaluation(changed, f.run, formal(path.join(f.probe, 'admission.json'))), /admission|receipt|match/i);
  await appendFile(f.module, '\n// Changed implementation\n');
  await assert.rejects(runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json'))), /changed/i);
  assert.equal(await f.targetCalls(), before);
});

test('copied receipt directories and expired receipts fail before target calls', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  const copy = path.join(f.root, 'copied-probe');
  await cp(f.probe, copy, { recursive: true });
  const before = await f.targetCalls();
  await assert.rejects(runEvaluation(f.prepared, f.run, formal(path.join(copy, 'admission.json'))), /directory|relocat|receipt/i);
  const receiptPath = path.join(f.probe, 'admission.json');
  const receipt = await readJson<any>(receiptPath);
  receipt.expiresAt = '2000-01-01T00:00:00.000Z';
  const { digest: _, ...body } = receipt;
  receipt.digest = hash(body);
  await writeJson(receiptPath, receipt);
  await assert.rejects(runEvaluation(f.prepared, f.run, formal(receiptPath)), /expir|validity/i);
  assert.equal(await f.targetCalls(), before);
});

test('missing probe lifecycle evidence and changed grading records invalidate admission', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  const artifact = (await readdir(path.join(f.probe, 'artifacts')))[0]!;
  await rm(path.join(f.probe, 'artifacts', artifact));
  const before = await f.targetCalls();
  await assert.rejects(runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json'))), /evidence|inventory|receipt/i);
  assert.equal(await f.targetCalls(), before);
  await runEvaluation(f.prepared, f.run);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  const records = path.join(f.calibration, 'grades', f.grading.versionHash, 'records');
  const file = path.join(records, (await readdir(records))[0]!);
  const record = await readJson<any>(file);
  await writeJson(file, { ...record, score: record.score === 1 ? 0 : 1 });
  const judgeBefore = await f.judgeCalls();
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json'))), /evidence|inventory|receipt/i);
  assert.equal(await f.judgeCalls(), judgeBefore);
});

test('saved calibration expectations are recomputed even when integrity hashes are recalculated', async () => {
  const f = await setup();
  await runEvaluation(f.prepared, f.run);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  const records = path.join(f.calibration, 'grades', f.grading.versionHash, 'records');
  const file = path.join(records, (await readdir(records))[0]!);
  const record = await readJson<any>(file);
  await writeJson(file, { ...record, score: record.score === 1 ? 0 : 1 });
  const receiptPath = path.join(f.calibration, 'admission.json');
  const receipt = await readJson<any>(receiptPath);
  for (const entry of receipt.evidence) entry.sha256 = await fileHash(path.join(f.calibration, entry.path));
  const { digest: _, ...body } = receipt;
  receipt.digest = hash(body);
  await writeJson(receiptPath, receipt);
  const before = await f.judgeCalls();
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(receiptPath)), /expectation mismatch/i);
  assert.equal(await f.judgeCalls(), before);
});

test('wrong phase, changed grader rubric, and changed calibration fixtures cannot reuse receipts', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  await runEvaluation(f.prepared, f.run);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  const before = await f.judgeCalls();
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(path.join(f.probe, 'admission.json'))), /phase/i);
  const changed = structuredClone(f.grading);
  changed.plan.judges[0]!.prompt = 'Changed rubric';
  changed.versionHash = hash({ plan: changed.plan, files: changed.files });
  await assert.rejects(gradeEvaluation(f.run, changed, formal(path.join(f.calibration, 'admission.json'))), /configuration/i);
  await appendFile(f.fixtures, '\n');
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json'))), /changed/i);
  assert.equal(await f.judgeCalls(), before);
});

test('an exploratory grading version cannot be relabeled formal after its judge calls', async () => {
  const f = await setup();
  await runEvaluation(f.prepared, f.run);
  await gradeEvaluation(f.run, f.grading);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  const before = await f.judgeCalls();
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json'))), /cannot change/i);
  assert.equal(await f.judgeCalls(), before);
});

test('formal resume cannot silently downgrade or bypass damaged original evidence', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  await runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json')));
  const before = await f.targetCalls();
  await rm(path.join(f.probe, 'preflight.json'));
  await assert.rejects(resumeEvaluation(f.run), /ENOENT|evidence|receipt/i);
  assert.equal(await f.targetCalls(), before);
});

test('a missing grading receipt cannot overwrite an existing formal grading admission', async () => {
  const f = await setup();
  await runEvaluation(f.prepared, f.run);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  await gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json')));
  const manifestPath = path.join(f.run, 'grades', f.grading.versionHash, 'manifest.json');
  const before = await readFile(manifestPath, 'utf8');
  const calls = await f.judgeCalls();
  await rm(path.join(f.calibration, 'admission.json'));
  await assert.rejects(gradeEvaluation(f.run, f.grading), /ENOENT|receipt/i);
  assert.equal(await readFile(manifestPath, 'utf8'), before);
  assert.equal(await f.judgeCalls(), calls);
});

test('explicit formal receipt renewal preserves earlier admission records and does not repeat completed work', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  await runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json')));
  const prior = (await readManifest(f.run)).admission;
  const nextProbe = path.join(f.root, 'next-probe');
  await probeExecution(f.prepared, nextProbe);
  const calls = await f.targetCalls();
  await resumeEvaluation(f.run, { receipt: path.join(nextProbe, 'admission.json') });
  const manifest = await readManifest(f.run);
  assert.deepEqual(manifest.admissionHistory, [prior]);
  assert.notEqual(manifest.admission?.receiptHash, prior?.receiptHash);
  assert.equal(await f.targetCalls(), calls);
  await assert.rejects(resumeEvaluation(f.run, { mode: 'exploratory' }), /cannot change/i);
});

test('a fresh receipt cannot mix another recorded runtime into an existing formal run', async () => {
  const f = await setup();
  await probeExecution(f.prepared, f.probe);
  await runEvaluation(f.prepared, f.run, formal(path.join(f.probe, 'admission.json')));
  const manifestPath = path.join(f.run, 'manifest.json');
  const manifest = await readManifest(f.run);
  manifest.runtime!.nodeVersion = 'different-runtime';
  await writeJson(manifestPath, manifest);
  const nextProbe = path.join(f.root, 'renewal');
  await probeExecution(f.prepared, nextProbe);
  const calls = await f.targetCalls();
  await assert.rejects(resumeEvaluation(f.run, { receipt: path.join(nextProbe, 'admission.json') }), /runtime differs/i);
  assert.equal(await f.targetCalls(), calls);
});

test('low-level default is explicitly exploratory and old manifests remain resumable', async () => {
  const f = await setup();
  const result = await runEvaluation(f.prepared, f.run);
  assert.equal((result as any).mode, 'exploratory');
  const manifest = await readJson<any>(path.join(f.run, 'manifest.json'));
  assert.equal(manifest.admission.mode, 'exploratory');
  delete manifest.admission;
  await writeJson(path.join(f.run, 'manifest.json'), manifest);
  assert.equal((await resumeEvaluation(f.run) as any).mode, 'legacy_unverified');
  assert.equal((await resumeEvaluation(f.run, { mode: 'exploratory' }) as any).mode, 'legacy_unverified');
});

test('declared endpoint and model environment changes invalidate execution admission without exposing values', async () => {
  const endpointKey = `ONE_EVAL_TEST_ENDPOINT_${process.pid}`;
  const modelKey = `ONE_EVAL_TEST_MODEL_${process.pid}`;
  process.env[endpointKey] = 'https://private-original.invalid/secret-deployment';
  process.env[modelKey] = 'private-model-a';
  try {
    const f = await setup({ endpoint: `\${ENV:${endpointKey}}`, model: `\${ENV:${modelKey}}` });
    await probeExecution(f.prepared, f.probe);
    const receiptPath = path.join(f.probe, 'admission.json');
    const text = await readFile(receiptPath, 'utf8');
    assert.ok(!text.includes(process.env[endpointKey]!));
    assert.ok(!text.includes(process.env[modelKey]!));
    const before = await f.targetCalls();
    process.env[endpointKey] = 'https://different.invalid/other-deployment';
    await assert.rejects(runEvaluation(f.prepared, f.run, formal(receiptPath)), /environment changed/i);
    process.env[endpointKey] = 'https://private-original.invalid/secret-deployment';
    process.env[modelKey] = 'private-model-b';
    await assert.rejects(runEvaluation(f.prepared, f.run, formal(receiptPath)), /environment changed/i);
    assert.equal(await f.targetCalls(), before);
  } finally { delete process.env[endpointKey]; delete process.env[modelKey]; }
});

test('command grader environment mappings bind actual values before calibration and formal grading', async () => {
  const key = `ONE_EVAL_TEST_GRADER_${process.pid}`;
  process.env[key] = 'original-secret';
  try {
    const f = await setup();
    const config = await readJson<any>(f.judges);
    config.judges[0].env = { BUSINESS_MODE: key };
    await writeJson(f.judges, config);
    const prepared = await prepareGrading(f.judges);
    await runEvaluation(f.prepared, f.run);
    await calibrateGrading(prepared, f.fixtures, f.calibration);
    const receiptPath = path.join(f.calibration, 'admission.json');
    assert.ok(!(await readFile(receiptPath, 'utf8')).includes('original-secret'));
    const before = await f.judgeCalls();
    process.env[key] = 'changed-secret';
    await assert.rejects(gradeEvaluation(f.run, prepared, formal(receiptPath)), /environment changed/i);
    assert.equal(await f.judgeCalls(), before);
  } finally { delete process.env[key]; }
});

test('environment mutation during a probe cannot issue a receipt for different settings', async () => {
  const key = `ONE_EVAL_TEST_MUTATING_${process.pid}`;
  process.env[key] = 'original';
  try {
    const f = await setup({ environmentBinding: `\${ENV:${key}}` });
    const source = await readFile(f.module, 'utf8');
    await writeFile(f.module, source.replace("await log('execute',context);", `await log('execute',context);process.env[${JSON.stringify(key)}]='changed';`));
    const prepared = await preparePlan(f.config);
    const result = await probeExecution(prepared, f.probe);
    assert.equal(result.ok, false);
    assert.equal(result.receiptPath, undefined);
    assert.match(result.error ?? '', /environment changed/i);
    await assert.rejects(readFile(path.join(f.probe, 'admission.json')), { code: 'ENOENT' });
  } finally { delete process.env[key]; }
});

test('rejected formal grading creates no orphan version and leaves reports readable', async () => {
  const f = await setup();
  await runEvaluation(f.prepared, f.run);
  const before = await buildReport(f.run);
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal()), /receipt/i);
  assert.equal(await f.judgeCalls(), 0);
  assert.deepEqual(await buildReport(f.run), before);
  await assert.rejects(readdir(path.join(f.run, 'grades', f.grading.versionHash)), { code: 'ENOENT' });
  await gradeEvaluation(f.run, f.grading);
  const report = await buildReport(f.run);
  const versions = await readdir(path.join(f.run, 'grades'));
  const changed = structuredClone(f.grading);
  changed.plan.judges[0]!.prompt = 'Another grading version';
  changed.versionHash = hash({ plan: changed.plan, files: changed.files });
  await assert.rejects(gradeEvaluation(f.run, changed, formal()), /receipt/i);
  assert.deepEqual(await readdir(path.join(f.run, 'grades')), versions);
  assert.deepEqual(await buildReport(f.run), report);
});

test('a missing grading manifest cannot reclassify retained exploratory records as formal', async () => {
  const f = await setup();
  await runEvaluation(f.prepared, f.run);
  await gradeEvaluation(f.run, f.grading);
  await calibrateGrading(f.grading, f.fixtures, f.calibration);
  const manifest = path.join(f.run, 'grades', f.grading.versionHash, 'manifest.json');
  await rm(manifest);
  const calls = await f.judgeCalls();
  await assert.rejects(gradeEvaluation(f.run, f.grading, formal(path.join(f.calibration, 'admission.json'))), /missing|lacks|incomplete/i);
  await assert.rejects(readFile(manifest), { code: 'ENOENT' });
  assert.equal(await f.judgeCalls(), calls);
});

test('formal recovery rejects a changed environment before loading the recovery adapter', async () => {
  const key = `ONE_EVAL_TEST_RECOVERY_${process.pid}`;
  process.env[key] = 'original';
  try {
    const f = await blockedFormal({ endpoint: `\${ENV:${key}}` });
    const before = await f.targetCalls();
    process.env[key] = 'different-endpoint';
    await assert.rejects(recoverEvaluation(f.run), /environment differs/i);
    assert.equal(await f.targetCalls(), before);
    assert.equal(await readFile(f.control, 'utf8'), 'fail');
  } finally { delete process.env[key]; }
});

test('expired admission permits recovery in the original environment but still rejects resume', async (t) => {
  const f = await blockedFormal();
  const before = await f.targetCalls();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + ADMISSION_TTL_MS + 1000 });
  assert.equal((await recoverEvaluation(f.run)).blocked, false);
  assert.equal(await readFile(f.control, 'utf8'), 'ok');
  assert.equal(await f.targetCalls(), before + 1);
  await assert.rejects(resumeEvaluation(f.run), /expired/i);
  assert.equal(await f.targetCalls(), before + 1);
});
