import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getRuntimeProvenance } from './provenance.js';
import { hash, fileHash, readJson, readManifest, readRunState, listArtifacts, readAttemptLedger, validateExecutionEvidence,
  validatePreparedPlan, verifyFiles, canonicalDirectory, writeJson, withRunLock } from './storage.js';
import { readGradeRecords, readGradeReservations, readGradingState, validateArtifactHash, validateGradeRecordLinks,
  validateGradingManifest, validatePreparedGrading, type GradeManifest } from './grading.js';
import { validateCalibrationFixtures } from './preflight.js';
import type { PreparedGrading, PreparedPlan } from './types.js';

export type AdmissionMode = 'formal' | 'exploratory';
export interface AdmissionOptions { mode?: AdmissionMode; receipt?: string }
export interface AdmissionRecord {
  version: 1;
  mode: AdmissionMode;
  receiptPath?: string;
  receiptHash?: string;
  verifiedAt?: string;
}
export const ADMISSION_TTL_MS = 24 * 60 * 60 * 1000;
type Phase = 'execution' | 'grading';
type Prepared = PreparedPlan | PreparedGrading;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  version: z.literal(1), kind: z.literal('admission_receipt'), phase: z.enum(['execution', 'grading']),
  directory: z.string().min(1), sourceHash: digest, preparedHash: digest, runtimeHash: digest, environmentHash: digest,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  evidence: z.array(z.object({ path: z.string().min(1), sha256: digest }).strict()).min(1), digest,
}).strict();
export type AdmissionReceipt = z.infer<typeof receiptSchema>;
export function getAdmissionReceiptSchema(): unknown { return z.toJSONSchema(receiptSchema); }
const sourceHash = (phase: Phase, prepared: Prepared) => phase === 'execution' ? (prepared as PreparedPlan).planHash : (prepared as PreparedGrading).versionHash;

/** Hash only declared behavior environment bindings; never persist resolved values. */
export function environmentFingerprint(prepared: Prepared): string {
  const keys = new Set<string>();
  function visit(value: unknown): void {
    if (typeof value === 'string') for (const match of value.matchAll(/\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g)) keys.add(match[1]!);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  const visitProvider = (provider: unknown): void => {
    if (provider && typeof provider === 'object' && 'config' in provider) visit(provider.config);
  };
  if ('target' in prepared.plan) {
    visit(prepared.plan.target.config);
    visitProvider(prepared.plan.target.provider);
    for (const item of prepared.plan.cases) if (item.conversation?.mode === 'simulated') visitProvider(item.conversation.provider);
  } else for (const judge of prepared.plan.judges) {
    visitProvider(judge.provider);
    visit(judge.env);
    // Command graders map child environment names to raw host variable names.
    for (const reference of Object.values(judge.env ?? {})) keys.add(reference);
  }
  return hash([...keys].sort().map(key => [key, process.env[key] ?? null]));
}

export function validateAdmissionRecord(record: AdmissionRecord | undefined): void {
  if (record === undefined) return;
  if (!record || record.version !== 1 || !['formal', 'exploratory'].includes(record.mode)) throw new Error('Invalid admission mode record');
  if (record.mode === 'formal') {
    if (typeof record.receiptPath !== 'string' || !path.isAbsolute(record.receiptPath) || !/^[a-f0-9]{64}$/.test(record.receiptHash ?? '') || !Number.isFinite(Date.parse(record.verifiedAt ?? ''))) throw new Error('Formal admission record requires a verified receipt');
  } else if (record.receiptPath !== undefined || record.receiptHash !== undefined || record.verifiedAt !== undefined) throw new Error('Exploratory admission cannot claim a verified receipt');
}

async function inventory(directory: string): Promise<AdmissionReceipt['evidence']> {
  const evidence: AdmissionReceipt['evidence'] = [];
  async function scan(relative: string) {
    for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!relative && ['admission.json', 'work', '.one-eval.lock'].includes(entry.name)) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Admission evidence cannot contain symbolic links');
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) evidence.push({ path: file, sha256: await fileHash(path.join(directory, file)) });
      else throw new Error('Unsupported admission evidence file');
    }
  }
  await scan('');
  return evidence;
}

async function checkSnapshots(directory: string, prepared: Prepared): Promise<void> {
  for (const file of prepared.files) if (await fileHash(path.join(directory, 'sources', file.sha256)) !== file.sha256) throw new Error('Admission source snapshot hash mismatch');
}

async function executionEvidence(directory: string, prepared: PreparedPlan): Promise<void> {
  const request = await readJson<any>(path.join(directory, 'probe-request.json'));
  const result = await readJson<any>(path.join(directory, 'preflight.json'));
  const manifest = await readManifest(directory);
  if (!manifest.runtime || hash(manifest.runtime) !== hash(await getRuntimeProvenance())) throw new Error('Probe runtime changed since the evidence was executed');
  if (request.environmentHash !== environmentFingerprint(prepared) || manifest.environmentHash !== environmentFingerprint(manifest.prepared)) throw new Error('Probe environment changed since the evidence was executed');
  if (request.version !== 1 || request.kind !== 'execution_probe' || request.sourcePlanHash !== prepared.planHash ||
    result.kind !== 'execution_probe' || result.sourcePlanHash !== prepared.planHash || result.probePlanHash !== manifest.prepared.planHash ||
    !Array.isArray(request.caseIds) || request.caseIds.length < 1 || request.caseIds.length > 10) throw new Error('Execution admission evidence does not match the original plan');
  const plan = structuredClone(prepared.plan);
  plan.name = `${plan.name} (execution probe)`;
  plan.cases = plan.cases.slice(0, request.caseIds.length);
  plan.execution = { ...plan.execution, repeats: 1, concurrency: 1 };
  if (hash(request.caseIds) !== hash(plan.cases.map(item => item.id)) || hash({ plan, files: prepared.files }) !== manifest.prepared.planHash ||
      manifest.prepared.baseDir !== prepared.baseDir || request.probePlanHash !== manifest.prepared.planHash) throw new Error('Probe sample or source identity differs from the admission plan');
  const turns = plan.cases.reduce((sum, item) => sum + (item.conversation?.mode === 'scripted' ? 1 + item.conversation.turns.length : item.conversation?.mode === 'simulated' ? item.conversation.maxTurns : 1), 0);
  if (turns > 30 || request.maxTargetTurns !== turns) throw new Error('Execution probe exceeds its recorded bounds');
  await checkSnapshots(directory, prepared);
  const [artifacts, ledger, state] = await Promise.all([listArtifacts(directory), readAttemptLedger(directory), readRunState(directory)]);
  const problems = validateExecutionEvidence(manifest, artifacts, ledger);
  if (problems.length || state.blocked || state.activeProcess !== undefined || state.limitReached || artifacts.length !== plan.cases.length || ledger.length !== artifacts.length) throw new Error('Execution admission requires complete lifecycle evidence');
  for (const item of artifacts) {
    validateArtifactHash(item);
    if (item.attempt !== 1 || item.repeat !== 0 || item.trialId !== hash({ runId: manifest.runId, caseId: item.caseId, repeat: 0 }) ||
      item.isolation?.ok !== true || !item.isolation.evidence.trim()) throw new Error('Probe isolation or attempt evidence is invalid');
  }
  if (result.ok !== true || result.error !== undefined) throw new Error('Execution probe did not pass');
}

async function gradingEvidence(directory: string, prepared: PreparedGrading): Promise<void> {
  const request = await readJson<any>(path.join(directory, 'calibration-request.json'));
  const result = await readJson<any>(path.join(directory, 'calibration.json'));
  const execution = await readManifest(directory);
  const gradeDirectory = path.join(directory, 'grades', prepared.versionHash);
  const grading = await readJson<GradeManifest>(path.join(gradeDirectory, 'manifest.json'));
  validateGradingManifest(grading, execution, prepared.versionHash);
  if (!grading.runtime || hash(grading.runtime) !== hash(await getRuntimeProvenance())) throw new Error('Calibration runtime changed since the evidence was graded');
  if (grading.environmentHash !== environmentFingerprint(prepared)) throw new Error('Calibration environment changed since the evidence was graded');
  if (hash(grading.prepared) !== hash(prepared) || request.version !== 1 || request.kind !== 'grading_calibration' || request.origin !== 'imported_fixtures' || request.targetInvoked !== false ||
    request.gradingVersion !== prepared.versionHash || result.gradingVersion !== prepared.versionHash || result.kind !== 'grading_calibration') throw new Error('Calibration admission source identity mismatch');
  const snapshot = path.join(directory, 'sources', request.fixturesHash);
  if (!/^[a-f0-9]{64}$/.test(request.fixturesHash) || await fileHash(snapshot) !== request.fixturesHash || result.fixturesHash !== request.fixturesHash) throw new Error('Calibration fixture snapshot hash mismatch');
  const fixtures = validateCalibrationFixtures(await readJson(snapshot));
  if (hash(request.fixtures) !== hash(fixtures.fixtures.map(item => ({ id: item.id, label: item.label, expected: item.expected })))) throw new Error('Calibration expectations differ from the source fixtures');
  await checkSnapshots(gradeDirectory, prepared);
  await verifyFiles(execution.prepared.files);
  await checkSnapshots(directory, execution.prepared);
  const [artifacts, ledger, records, reservations, state] = await Promise.all([
    listArtifacts(directory), readAttemptLedger(directory), readGradeRecords(directory, prepared.versionHash),
    readGradeReservations(directory, prepared.versionHash), readGradingState(directory, prepared.versionHash),
  ]);
  if (ledger.length || artifacts.length !== fixtures.fixtures.length || execution.prepared.plan.cases.length !== fixtures.fixtures.length || state.blocked || state.activeProcess !== undefined || state.limitReached || !state.updatedAt) throw new Error('Calibration requires complete imported fixture and grading evidence');
  if (validateExecutionEvidence(execution, artifacts, ledger).length) throw new Error('Incomplete calibration execution evidence');
  for (const fixture of fixtures.fixtures) {
    const artifact = artifacts.find(item => item.caseId === fixture.id);
    const item = execution.prepared.plan.cases.find(item => item.id === fixture.id);
    if (!artifact || !item || item.input !== fixture.input || hash([item.reference]) !== hash([fixture.reference]) || artifact.output !== fixture.output || artifact.repeat !== 0 || artifact.attempt !== 1 ||
      hash(artifact.messages) !== hash(fixture.messages ?? [{ role: 'user', content: fixture.input }, { role: 'assistant', content: fixture.output }]) ||
      hash(artifact.metadata) !== hash({ ...fixture.metadata, oneEvalProvenance: { kind: 'imported_calibration_fixture', fixturesHash: request.fixturesHash, targetInvoked: false } })) throw new Error('Calibration saved output differs from its imported fixture');
    validateArtifactHash(artifact);
  }
  validateGradeRecordLinks(records, execution, prepared, artifacts);
  validateGradeRecordLinks(reservations, execution, prepared, artifacts);
  const planned = fixtures.fixtures.length * prepared.plan.judges.reduce((sum, judge) => sum + judge.repeats, 0);
  if (records.length !== planned || reservations.length !== planned || request.planned !== planned || new Set(records.map(item => item.id)).size !== planned ||
    reservations.some(ticket => !records.some(record => record.id === ticket.id))) throw new Error('Calibration requires every recorded judge attempt and reservation');
  for (const fixture of fixtures.fixtures) for (const judge of prepared.plan.judges) for (let repeat = 0; repeat < judge.repeats; repeat++) {
    const matching = records.filter(item => item.caseId === fixture.id && item.judgeId === judge.id && item.repeat === repeat);
    const record = matching[0];
    if (matching.length !== 1 || !record || record.attempt !== 1 || record.diagnostic || record.cleanupDiagnostic || record.status !== fixture.expected.status ||
      fixture.expected.status === 'scored' && (record.score === undefined || record.score < fixture.expected.minScore || record.score > fixture.expected.maxScore)) throw new Error('Calibration expectation mismatch in saved judge evidence');
  }
  if (result.ok !== true || result.error !== undefined) throw new Error('Grading calibration did not pass');
}

async function verifyPrepared(phase: Phase, prepared: Prepared): Promise<void> {
  if (phase === 'execution') validatePreparedPlan(prepared as PreparedPlan);
  else validatePreparedGrading(prepared as PreparedGrading);
  await verifyFiles(prepared.files);
}
async function verifyEvidence(phase: Phase, directory: string, prepared: Prepared): Promise<void> {
  if (phase === 'execution') await executionEvidence(directory, prepared as PreparedPlan);
  else await gradingEvidence(directory, prepared as PreparedGrading);
}

/** Local integrity receipt, not a signature or proof against a malicious filesystem owner. */
export async function issueAdmissionReceipt(phase: Phase, prepared: Prepared, directory: string): Promise<string> {
  directory = await canonicalDirectory(directory);
  return withRunLock(directory, async () => {
    await verifyPrepared(phase, prepared);
    await verifyEvidence(phase, directory, prepared);
    const issuedAt = new Date().toISOString();
    const body = { version: 1 as const, kind: 'admission_receipt' as const, phase, directory, sourceHash: sourceHash(phase, prepared), preparedHash: hash(prepared),
      runtimeHash: hash(await getRuntimeProvenance()), environmentHash: environmentFingerprint(prepared), issuedAt, expiresAt: new Date(Date.parse(issuedAt) + ADMISSION_TTL_MS).toISOString(), evidence: await inventory(directory) };
    const receipt = { ...body, digest: hash(body) };
    const receiptPath = path.join(directory, 'admission.json');
    await writeJson(receiptPath, receipt);
    return receiptPath;
  });
}

export async function verifyAdmissionReceipt(phase: Phase, prepared: Prepared, receiptPath: string): Promise<AdmissionRecord> {
  if (typeof receiptPath !== 'string' || !receiptPath.trim()) throw new Error(`Formal ${phase} requires an admission receipt`);
  const directory = await canonicalDirectory(path.dirname(path.resolve(receiptPath)));
  if (path.basename(receiptPath) !== 'admission.json') throw new Error('Admission receipt must be the evidence directory admission.json');
  return withRunLock(directory, async () => {
    const receipt = receiptSchema.parse(await readJson(path.join(directory, 'admission.json')));
    const { digest: expected, ...body } = receipt;
    if (receipt.directory !== directory) throw new Error('Admission receipt directory changed; copied evidence cannot be relocated');
    if (hash(body) !== expected) throw new Error('Admission receipt digest mismatch');
    const now = Date.now(), issued = Date.parse(receipt.issuedAt), expires = Date.parse(receipt.expiresAt);
    if (issued > now || expires <= now || expires - issued !== ADMISSION_TTL_MS) throw new Error('Admission receipt expired or has invalid validity dates; repeat the preflight');
    if (receipt.phase !== phase || receipt.sourceHash !== sourceHash(phase, prepared) || receipt.preparedHash !== hash(prepared)) throw new Error('Admission receipt does not match this phase and prepared source configuration');
    await verifyPrepared(phase, prepared);
    if (receipt.environmentHash !== environmentFingerprint(prepared)) throw new Error('Admission environment changed; repeat the preflight with the current bindings');
    if (receipt.runtimeHash !== hash(await getRuntimeProvenance())) throw new Error('Admission runtime changed; repeat the preflight with the current implementation');
    if (hash(receipt.evidence) !== hash(await inventory(directory))) throw new Error('Admission evidence inventory changed or is incomplete');
    await verifyEvidence(phase, directory, prepared);
    return { version: 1, mode: 'formal', receiptPath: path.join(directory, 'admission.json'), receiptHash: receipt.digest, verifiedAt: new Date().toISOString() };
  });
}

export async function createAdmission(phase: Phase, prepared: Prepared, options: AdmissionOptions = {}): Promise<AdmissionRecord> {
  if (options.mode !== undefined && !['formal', 'exploratory'].includes(options.mode)) throw new Error('Unknown admission mode');
  if ((options.mode ?? 'exploratory') === 'formal') return verifyAdmissionReceipt(phase, prepared, options.receipt ?? '');
  if (options.receipt !== undefined) throw new Error('Exploratory mode cannot use a formal admission receipt');
  return { version: 1, mode: 'exploratory' };
}

export async function refreshAdmission(phase: Phase, prepared: Prepared, previous: AdmissionRecord | undefined, options: AdmissionOptions = {}): Promise<AdmissionRecord | undefined> {
  validateAdmissionRecord(previous);
  if (options.mode !== undefined && options.mode !== previous?.mode && !(previous === undefined && options.mode === 'exploratory')) throw new Error('An existing run or grading version cannot change admission mode');
  if (previous?.mode !== 'formal') {
    if (options.receipt !== undefined) throw new Error('Historical or exploratory evidence cannot be promoted to formal admission');
    return previous;
  }
  const checked = await verifyAdmissionReceipt(phase, prepared, options.receipt ?? previous.receiptPath!);
  if (!options.receipt && checked.receiptHash !== previous.receiptHash) throw new Error('Stored admission receipt was replaced; supply a new receipt explicitly to refresh admission');
  return checked.receiptHash === previous.receiptHash ? previous : checked;
}
