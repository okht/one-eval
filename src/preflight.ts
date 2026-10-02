import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ENGINE_VERSION } from './engine.js';
import { classifyError } from './diagnostics.js';
import { runEvaluation, summarizeRun } from './execution.js';
import { gradeEvaluation, latestGradeRecords, readGradeRecords, readGradingState, validatePreparedGrading } from './grading.js';
import { canonicalDirectory, hash, latestArtifacts, listArtifacts, snapshotSources, validatePreparedPlan, verifyFiles, writeArtifact, writeJson, writeRunState } from './storage.js';
import { environmentFingerprint, issueAdmissionReceipt } from './admission.js';
import { getRuntimeProvenance } from './provenance.js';
import type { GradeRecord, PreparedGrading, PreparedPlan, RunManifest, RunSummary, TrialArtifact } from './types.js';

export interface PreflightCheck { name: string; ok: boolean; evidence: string }
export interface ExecutionProbeResult {
  version: 1;
  kind: 'execution_probe';
  ok: boolean;
  directory: string;
  sourcePlanHash: string;
  probePlanHash: string;
  caseIds: string[];
  maxTargetTurns: number;
  summary: RunSummary | null;
  checks: PreflightCheck[];
  isolation: {
    mode: 'stateless' | 'managed';
    scope: 'independent' | 'shared';
    basis: 'provider_declaration' | 'adapter_verification';
    evidence: string;
    limits: string[];
  };
  error?: string;
  receiptPath?: string;
}

const describe = (error: unknown) => classifyError(error, 'preflight').message;

async function ownDirectory(directory: string): Promise<string> {
  const absolute = path.resolve(directory);
  await mkdir(path.dirname(absolute), { recursive: true });
  // Never place calibration/probe files into an existing user run, even an empty directory.
  try { await mkdir(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Preflight output directory already exists; choose a new directory');
    throw error;
  }
  return absolute;
}

/** Executes a small real subset, independently of any grading configuration. */
export async function probeExecution(prepared: PreparedPlan, directory: string, options: { caseLimit?: number } = {}): Promise<ExecutionProbeResult> {
  validatePreparedPlan(prepared);
  await verifyFiles(prepared.files);
  const caseLimit = options.caseLimit ?? 2;
  if (!Number.isInteger(caseLimit) || caseLimit < 1 || caseLimit > 10) throw new Error('Probe caseLimit must be an integer from 1 to 10');
  const plan = structuredClone(prepared.plan);
  plan.name = `${plan.name} (execution probe)`;
  plan.cases = plan.cases.slice(0, caseLimit);
  if (!plan.cases.length) throw new Error('An execution probe requires at least one case');
  plan.execution = { ...plan.execution, repeats: 1, concurrency: 1 };
  const maxTargetTurns = plan.cases.reduce((sum, item) => sum + (item.conversation?.mode === 'scripted' ? 1 + item.conversation.turns.length : item.conversation?.mode === 'simulated' ? item.conversation.maxTurns : 1), 0);
  if (maxTargetTurns > 30) throw new Error('Selected probe cases exceed 30 target turns; reduce caseLimit or provide a smaller probe plan');
  const probe: PreparedPlan = { ...prepared, plan, planHash: hash({ plan, files: prepared.files }) };
  directory = await ownDirectory(directory);
  await writeJson(path.join(directory, 'probe-request.json'), {
    version: 1, kind: 'execution_probe', sourcePlanHash: prepared.planHash,
    environmentHash: environmentFingerprint(prepared),
    probePlanHash: probe.planHash, caseIds: plan.cases.map(item => item.id), maxTargetTurns,
    changes: { selection: 'first cases in input order', repeats: 1, concurrency: 1 },
  });
  let summary: RunSummary | null = null;
  let error: string | undefined;
  try { summary = await runEvaluation(probe, directory); }
  catch (caught) {
    error = describe(caught);
    try { summary = await summarizeRun(directory); } catch { /* Preserve the original failure if manifest creation failed. */ }
  }
  const artifacts = latestArtifacts(await listArtifacts(directory));
  const checks: PreflightCheck[] = [
    { name: 'execution_complete', ok: !!summary && summary.completed === plan.cases.length && summary.failed === 0 && summary.pending === 0 && !summary.blocked && !error, evidence: summary ? JSON.stringify(summary) : error ?? 'No run summary available' },
    { name: 'isolation_verification', ok: artifacts.length === plan.cases.length && artifacts.every(item => item.isolation?.ok === true), evidence: JSON.stringify(artifacts.map(item => ({ caseId: item.caseId, isolation: item.isolation ?? null }))) },
    { name: 'fresh_session_ids', ok: artifacts.length === plan.cases.length && new Set(artifacts.map(item => item.sessionId)).size === artifacts.length, evidence: `${new Set(artifacts.map(item => item.sessionId)).size} distinct runner session IDs for ${plan.cases.length} selected cases` },
    { name: 'cleanup', ok: artifacts.length === plan.cases.length && artifacts.every(item => item.status === 'completed' && !item.cleanupError) && summary?.blocked === false, evidence: 'Cleanup and adapter close must complete without blocking the run; each artifact retains lifecycle failures.' },
  ];
  const result: ExecutionProbeResult = {
    version: 1, kind: 'execution_probe', ok: checks.every(check => check.ok), directory,
    sourcePlanHash: prepared.planHash, probePlanHash: probe.planHash,
    caseIds: plan.cases.map(item => item.id), maxTargetTurns, summary, checks,
    isolation: {
      ...plan.target.isolation,
      basis: plan.target.kind === 'provider' ? 'provider_declaration' : 'adapter_verification',
      limits: [
        'Fresh runner session IDs establish runner bookkeeping only; remote memory isolation depends on the provider contract or adapter verification.',
        'This bounded sample does not certify all cases, concurrent operation, persistent memory, external databases, or future server state.',
        'Probe cases execute real target operations and may have the same business side effects as a formal evaluation.',
      ],
    },
    ...(error ? { error } : {}),
  };
  if (result.ok) result.receiptPath = path.join(await canonicalDirectory(directory), 'admission.json');
  await writeJson(path.join(directory, 'preflight.json'), result);
  if (result.ok) try { await issueAdmissionReceipt('execution', prepared, directory); }
  catch (caught) {
    result.ok = false; result.error = describe(caught); delete result.receiptPath;
    result.checks.push({ name: 'admission_evidence', ok: false, evidence: result.error });
    await writeJson(path.join(directory, 'preflight.json'), result);
  }
  return result;
}

const score = z.number().finite().min(0).max(1);
const expectationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('scored'), minScore: score, maxScore: score }).strict().refine(value => value.minScore <= value.maxScore, 'minScore must not exceed maxScore'),
  z.object({ status: z.literal('abstained') }).strict(),
  z.object({ status: z.literal('insufficient_evidence') }).strict(),
]);
const fixtureSchema = z.object({
  id: z.string().min(1), label: z.enum(['positive', 'negative', 'edge']), input: z.string(),
  reference: z.json().optional(), output: z.string(),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()).min(2).optional(),
  metadata: z.record(z.string(), z.json()).optional(), expected: expectationSchema,
}).strict();
const fixturesSchema = z.object({ version: z.literal(1), fixtures: z.array(fixtureSchema).min(2).max(100) }).strict();
export type CalibrationFixture = z.infer<typeof fixtureSchema>;
export type CalibrationFixtures = z.infer<typeof fixturesSchema>;
export type CalibrationExpectation = z.infer<typeof expectationSchema>;
export interface CalibrationResultItem {
  fixtureId: string;
  judgeId: string;
  repeat: number;
  status: 'matched' | 'mismatched' | 'grading_error' | 'missing';
  expected: CalibrationExpectation;
  actual?: { status: GradeRecord['status']; score?: number; reason: string };
  recordId?: string;
}
export interface GradingCalibrationResult {
  version: 1;
  kind: 'grading_calibration';
  ok: boolean;
  directory: string;
  gradingVersion: string;
  fixturesHash: string;
  planned: number;
  matched: number;
  mismatched: number;
  errors: number;
  missing: number;
  checks: PreflightCheck[];
  results: CalibrationResultItem[];
  error?: string;
  receiptPath?: string;
}

export function getCalibrationFixturesSchema(): unknown { return z.toJSONSchema(fixturesSchema, { io: 'input' }); }

export function validateCalibrationFixtures(raw: unknown): CalibrationFixtures {
  const document = fixturesSchema.parse(raw);
  if (new Set(document.fixtures.map(item => item.id)).size !== document.fixtures.length) throw new Error('Duplicate calibration fixture IDs');
  const positive = document.fixtures.filter(item => item.label === 'positive');
  const negative = document.fixtures.filter(item => item.label === 'negative');
  if (!positive.length || !negative.length) throw new Error('Calibration requires positive and negative scored anchors');
  for (const item of [...positive, ...negative]) if (item.expected.status !== 'scored') throw new Error('Positive and negative anchors require scored expectations');
  const positiveMinimum = Math.min(...positive.map(item => item.expected.status === 'scored' ? item.expected.minScore : 0));
  const negativeMaximum = Math.max(...negative.map(item => item.expected.status === 'scored' ? item.expected.maxScore : 1));
  if (positiveMinimum <= negativeMaximum) throw new Error('Positive and negative calibration score intervals must not overlap');
  for (const item of document.fixtures) if (item.messages) {
    if (item.messages.at(-1)?.role !== 'assistant' || item.messages.at(-1)?.content !== item.output) throw new Error(`Fixture ${item.id}: last message must be the saved assistant output`);
    if (item.messages.find(message => message.role === 'user')?.content !== item.input) throw new Error(`Fixture ${item.id}: first user message must match input`);
  }
  return document;
}

/** Grades imported known-answer fixtures without loading or invoking any target. */
export async function calibrateGrading(prepared: PreparedGrading, fixturesPath: string, directory: string): Promise<GradingCalibrationResult> {
  validatePreparedGrading(prepared);
  await verifyFiles(prepared.files);
  fixturesPath = path.resolve(fixturesPath);
  const bytes = await readFile(fixturesPath);
  const fixturesHash = createHash('sha256').update(bytes).digest('hex');
  const document = validateCalibrationFixtures(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
  const planned = document.fixtures.length * prepared.plan.judges.reduce((sum, judge) => sum + judge.repeats, 0);
  if (!Number.isSafeInteger(planned) || planned < 2 || planned > 10_000) throw new Error('Calibration must schedule between 2 and 10,000 judge calls');
  directory = await ownDirectory(directory);
  const createdAt = new Date().toISOString();
  const targetPath = path.join(directory, 'imported-fixtures.mjs');
  const guard = 'throw new Error("Calibration outputs are imported fixtures; no target execution is available.");\n';
  await writeFile(targetPath, guard, { flag: 'wx' });
  const files = [
    { path: fixturesPath, sha256: fixturesHash },
    { path: targetPath, sha256: createHash('sha256').update(guard).digest('hex') },
  ];
  const plan: PreparedPlan['plan'] = {
    version: 1, name: 'Imported grader calibration fixtures',
    cases: document.fixtures.map(item => ({ id: item.id, input: item.input, ...(item.reference !== undefined ? { reference: item.reference } : {}), weight: 1 })),
    target: { kind: 'module', path: targetPath, isolation: { mode: 'stateless', scope: 'independent', evidence: 'Imported fixture records; no target execution or environment isolation was measured.' }, retrySafe: false },
    execution: { repeats: 1, concurrency: 1, timeoutMs: 1 },
  };
  const manifest: RunManifest = {
    version: 1, runId: randomUUID(), createdAt,
    prepared: { plan, files, baseDir: directory, planHash: hash({ plan, files }) },
    engine: { name: 'promptfoo', version: ENGINE_VERSION },
    admission: { version: 1, mode: 'exploratory' }, runtime: await getRuntimeProvenance(),
    environmentHash: environmentFingerprint({ plan, files, baseDir: directory, planHash: hash({ plan, files }) }),
  };
  await snapshotSources(directory, files);
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  // A calibration directory may be graded/reported, but cannot be resumed as target execution.
  await writeRunState(directory, { blocked: true, reason: 'Imported calibration fixtures have no executable target.', updatedAt: createdAt });
  await writeJson(path.join(directory, 'calibration-request.json'), {
    version: 1, kind: 'grading_calibration', origin: 'imported_fixtures', targetInvoked: false,
    fixturesPath, fixturesHash, gradingVersion: prepared.versionHash, planned,
    fixtures: document.fixtures.map(item => ({ id: item.id, label: item.label, expected: item.expected })),
  });
  for (const item of document.fixtures) {
    const artifact: TrialArtifact = {
      version: 1, runId: manifest.runId, trialId: hash({ runId: manifest.runId, caseId: item.id, repeat: 0 }),
      caseId: item.id, repeat: 0, attempt: 1, sessionId: `imported-fixture:${randomUUID()}`,
      startedAt: createdAt, finishedAt: createdAt, status: 'completed', output: item.output,
      messages: item.messages ?? [{ role: 'user', content: item.input }, { role: 'assistant', content: item.output }],
      metadata: { ...item.metadata, oneEvalProvenance: { kind: 'imported_calibration_fixture', fixturesHash, targetInvoked: false } },
    };
    artifact.outputHash = hash({ output: artifact.output, messages: artifact.messages, metadata: artifact.metadata });
    await writeArtifact(directory, artifact);
  }
  let error: string | undefined;
  try { await gradeEvaluation(directory, prepared); }
  catch (caught) { error = describe(caught); }
  const records = [...latestGradeRecords(await readGradeRecords(directory, prepared.versionHash)).values()];
  const state = await readGradingState(directory, prepared.versionHash);
  const results: CalibrationResultItem[] = [];
  for (const fixture of document.fixtures) for (const judge of prepared.plan.judges) for (let repeat = 0; repeat < judge.repeats; repeat++) {
    const record = records.find(item => item.caseId === fixture.id && item.judgeId === judge.id && item.repeat === repeat);
    const matched = record && record.status === fixture.expected.status && (fixture.expected.status !== 'scored' || (typeof record.score === 'number' && record.score >= fixture.expected.minScore && record.score <= fixture.expected.maxScore));
    results.push({
      fixtureId: fixture.id, judgeId: judge.id, repeat, expected: fixture.expected,
      status: !record ? 'missing' : record.status === 'grading_error' ? 'grading_error' : matched ? 'matched' : 'mismatched',
      ...(record ? { actual: { status: record.status, ...(record.score !== undefined ? { score: record.score } : {}), reason: record.reason }, recordId: record.id } : {}),
    });
  }
  const count = (status: CalibrationResultItem['status']) => results.filter(item => item.status === status).length;
  const checks: PreflightCheck[] = [
    { name: 'positive_and_negative_anchors', ok: true, evidence: 'Validated distinct positive and negative scored expectations; expected labels and score bands are withheld from grader inputs.' },
    { name: 'complete_grading', ok: !error && !state.blocked && count('missing') === 0 && count('grading_error') === 0, evidence: JSON.stringify({ planned, records: records.length, errors: count('grading_error'), missing: count('missing'), blocked: state.blocked, reason: state.reason, error }) },
    { name: 'all_expectations_match', ok: count('matched') === planned, evidence: `${count('matched')} of ${planned} individual judge/repeat results match the supplied expectations; no averages mask disagreements.` },
  ];
  const result: GradingCalibrationResult = {
    version: 1, kind: 'grading_calibration', ok: checks.every(check => check.ok), directory,
    gradingVersion: prepared.versionHash, fixturesHash, planned, matched: count('matched'),
    mismatched: count('mismatched'), errors: count('grading_error'), missing: count('missing'), checks, results,
    ...(error ? { error } : {}),
  };
  if (result.ok) result.receiptPath = path.join(await canonicalDirectory(directory), 'admission.json');
  await writeJson(path.join(directory, 'calibration.json'), result);
  if (result.ok) try { await issueAdmissionReceipt('grading', prepared, directory); }
  catch (caught) {
    result.ok = false; result.error = describe(caught); delete result.receiptPath;
    result.checks.push({ name: 'admission_evidence', ok: false, evidence: result.error });
    await writeJson(path.join(directory, 'calibration.json'), result);
  }
  return result;
}
