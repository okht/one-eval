import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { PreparedPlan, RunManifest, RunState, SourceFile, TrialArtifact } from './types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export async function fileHash(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')) as T;
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, file); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
export async function verifyFiles(files: SourceFile[]): Promise<void> {
  for (const file of files) {
    if (await fileHash(file.path) !== file.sha256) throw new Error(`Source changed: ${file.path}. Create a new run or grading version.`);
  }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max; }
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return object(value) && Object.values(value).every(json);
}
function provider(value: unknown): boolean { return text(value) || object(value) && text(value.id) && (value.config === undefined || object(value.config) && json(value.config)); }

/** Validate persisted plans independently of their hash; a hash alone is not a schema. */
export function validatePreparedPlan(prepared: PreparedPlan): void {
  if (!object(prepared) || !object(prepared.plan) || !Array.isArray(prepared.files) || !text(prepared.baseDir)) throw new Error('Invalid prepared execution plan');
  const { plan, files } = prepared;
  if (plan.version !== 1 || !text(plan.name) || !Array.isArray(plan.cases) || !plan.cases.length || !object(plan.execution) || !object(plan.target)) throw new Error('Invalid execution plan in run manifest');
  if (files.some(file => !object(file) || !text(file.path) || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)) || new Set(files.map(file => file.path)).size !== files.length) throw new Error('Invalid execution source files in run manifest');
  const execution = plan.execution;
  if (!integer(execution.repeats, 1, 10_000) || !integer(execution.concurrency, 1, 100) || !integer(execution.timeoutMs, 1, 3_600_000) ||
      (execution.maxAttempts !== undefined && !integer(execution.maxAttempts, 1, 1_000_000)) || (execution.minIntervalMs !== undefined && !integer(execution.minIntervalMs, 0, 60_000)) || plan.cases.length * execution.repeats > 1_000_000) throw new Error('Invalid execution counts or limits in run manifest');
  const target = plan.target;
  if (!['module', 'provider'].includes(target.kind) || typeof target.retrySafe !== 'boolean' || !object(target.isolation) || !['stateless', 'managed'].includes(target.isolation.mode) || !['independent', 'shared'].includes(target.isolation.scope) || !text(target.isolation.evidence) || !target.isolation.evidence.trim() ||
      (target.config !== undefined && (!object(target.config) || !json(target.config))) ||
      (target.kind === 'module' && (!text(target.path) || target.provider !== undefined)) ||
      (target.kind === 'provider' && (!provider(target.provider) || target.path !== undefined || target.isolation.mode !== 'stateless')) ||
      (target.isolation.scope === 'shared' && execution.concurrency !== 1)) throw new Error('Invalid target in run manifest');
  const ids = new Set<string>();
  for (const item of plan.cases) {
    if (!object(item) || !text(item.id) || ids.has(item.id) || typeof item.input !== 'string' || typeof item.weight !== 'number' || !Number.isFinite(item.weight) || item.weight <= 0 ||
        (item.reference !== undefined && !json(item.reference)) || (item.metadata !== undefined && (!object(item.metadata) || !json(item.metadata)))) throw new Error('Invalid or duplicate case/weight in run manifest');
    ids.add(item.id);
    const conversation = item.conversation;
    if (conversation !== undefined && (!object(conversation) ||
        (conversation.mode === 'scripted' ? !Array.isArray(conversation.turns) || !conversation.turns.length || !conversation.turns.every(turn => typeof turn === 'string') :
         conversation.mode === 'simulated' ? !text(conversation.goal) || !provider(conversation.provider) || !integer(conversation.maxTurns, 1, 100) || (conversation.facts !== undefined && (!object(conversation.facts) || !json(conversation.facts))) || (conversation.constraints !== undefined && (!Array.isArray(conversation.constraints) || !conversation.constraints.every(value => typeof value === 'string'))) : true))) throw new Error('Invalid conversation in run manifest');
  }
  if (hash({ plan, files }) !== prepared.planHash) throw new Error('Invalid or modified run manifest: prepared plan hash mismatch');
}
export async function readManifest(directory: string): Promise<RunManifest> {
  const manifest = await readJson<RunManifest>(path.join(directory, 'manifest.json'));
  if (manifest.version !== 1 || !manifest.runId || !manifest.prepared?.plan ||
    hash({ plan: manifest.prepared.plan, files: manifest.prepared.files }) !== manifest.prepared.planHash) {
    throw new Error('Invalid or modified run manifest');
  }
  if (!text(manifest.runId) || !text(manifest.createdAt) || !object(manifest.engine) || manifest.engine.name !== 'promptfoo' || !text(manifest.engine.version)) throw new Error('Invalid run manifest identity');
  validatePreparedPlan(manifest.prepared);
  return manifest;
}
export async function readRunState(directory: string): Promise<RunState> {
  const state=await readJson<RunState>(path.join(directory, 'state.json'));
  if(!object(state)||typeof state.blocked!=='boolean'||typeof state.updatedAt!=='string'||(state.activeProcess!==undefined&&(!integer(state.activeProcess,1)||!state.blocked))||
    (state.reason!==undefined&&typeof state.reason!=='string')||(state.limitReached!==undefined&&typeof state.limitReached!=='boolean')||(state.limitReason!==undefined&&typeof state.limitReason!=='string'))throw new Error('Invalid run state');
  return state;
}
export async function canonicalDirectory(directory:string,create=false):Promise<string> {
  if(create)await mkdir(path.resolve(directory),{recursive:true});
  const resolved=await realpath(path.resolve(directory));
  return process.platform==='win32'?resolved.toLowerCase():resolved;
}
const stateWrites=new Map<string,Promise<void>>();
export async function writeRunState(directory: string, state: RunState): Promise<void> {
  const file=path.join(directory,'state.json');
  const snapshot=structuredClone(state);
  const previous=stateWrites.get(file)??Promise.resolve();
  const work=previous.then(()=>writeJson(file,snapshot));
  stateWrites.set(file,work);
  try{await work;}finally{if(stateWrites.get(file)===work)stateWrites.delete(file);}
}
export async function listArtifacts(directory: string): Promise<TrialArtifact[]> {
  const folder = path.join(directory, 'artifacts');
  let files: string[];
  try { files = await readdir(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
    const artifact = await readJson<TrialArtifact>(path.join(folder, file));
    validateArtifactStructure(artifact, file);
    return artifact;
  }));
}
export function latestArtifacts(artifacts: TrialArtifact[]): TrialArtifact[] {
  const latest = new Map<string, TrialArtifact>();
  const attempts = new Set<string>();
  for (const artifact of artifacts) {
    const key = JSON.stringify([artifact.trialId, artifact.attempt]);
    if (attempts.has(key)) throw new Error(`Duplicate or conflicting execution attempt: ${key}`);
    attempts.add(key);
    const previous = latest.get(artifact.trialId);
    if (previous && (previous.runId !== artifact.runId || previous.caseId !== artifact.caseId || previous.repeat !== artifact.repeat)) throw new Error('Conflicting execution identity across attempts');
    if ((latest.get(artifact.trialId)?.attempt ?? 0) < artifact.attempt) latest.set(artifact.trialId, artifact);
  }
  return [...latest.values()];
}

function validateArtifactStructure(artifact: TrialArtifact, file: string): void {
  if (!object(artifact) || artifact.version !== 1 || !text(artifact.runId) || !text(artifact.trialId) || !text(artifact.caseId) || !text(artifact.sessionId) || !text(artifact.startedAt) ||
      !integer(artifact.attempt, 1) || !integer(artifact.repeat, 0) || `${hash(artifact.trialId)}-${artifact.attempt}.json` !== file ||
      !['running','completed','execution_error','isolation_error','cleanup_error','interrupted','invalid_simulation'].includes(artifact.status) || !Array.isArray(artifact.messages) ||
      !artifact.messages.every(message => object(message) && ['system','user','assistant'].includes(message.role) && typeof message.content === 'string') ||
      (artifact.output !== undefined && typeof artifact.output !== 'string') || (artifact.outputHash !== undefined && (typeof artifact.outputHash !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.outputHash))) ||
      (artifact.metadata !== undefined && (!object(artifact.metadata) || !json(artifact.metadata))) || (artifact.error !== undefined && typeof artifact.error !== 'string') || (artifact.cleanupError !== undefined && typeof artifact.cleanupError !== 'string') ||
      (artifact.isolation !== undefined && (!object(artifact.isolation) || typeof artifact.isolation.ok !== 'boolean' || !text(artifact.isolation.evidence)))) throw new Error(`Invalid execution artifact identity or shape: ${file}`);
}

/** Reads execution reservations without reconciling or modifying interrupted runs. */
export async function readAttemptLedger(directory: string): Promise<TrialArtifact[]> {
  const folder = path.join(directory, 'attempts');
  let files: string[];
  try { files = await readdir(folder); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
    const artifact = await readJson<TrialArtifact>(path.join(folder, file));
    validateArtifactStructure(artifact, file);
    if (artifact.status !== 'running') throw new Error(`Invalid started-attempt ledger status: ${file}`);
    return artifact;
  }));
}

/** Returns incompleteness evidence; malformed identity relationships throw. */
export function validateExecutionEvidence(manifest: RunManifest, artifacts: TrialArtifact[], ledger: TrialArtifact[]): string[] {
  latestArtifacts(artifacts);
  latestArtifacts(ledger);
  const cases = new Set(manifest.prepared.plan.cases.map(item => item.id));
  const attempts = new Map(artifacts.map(item => [JSON.stringify([item.trialId, item.attempt]), item]));
  const slots = new Map<string, string>();
  const identities = new Map<string, string>();
  const sessions = new Map<string, string>();
  for (const item of [...artifacts, ...ledger]) {
    if (item.runId !== manifest.runId || !cases.has(item.caseId) || item.repeat >= manifest.prepared.plan.execution.repeats) throw new Error('Execution evidence does not belong to this run');
    const slot = JSON.stringify([item.caseId, item.repeat]);
    if (slots.has(slot) && slots.get(slot) !== item.trialId) throw new Error('Duplicate execution slot with conflicting trial identities');
    slots.set(slot, item.trialId);
    const identity = JSON.stringify([item.caseId, item.repeat]);
    if (identities.has(item.trialId) && identities.get(item.trialId) !== identity) throw new Error('Conflicting trial identity in execution evidence');
    identities.set(item.trialId, identity);
    const attemptIdentity = JSON.stringify([item.trialId, item.attempt]);
    if (sessions.has(item.sessionId) && sessions.get(item.sessionId) !== attemptIdentity) throw new Error('Distinct execution attempts share a runner session identity');
    sessions.set(item.sessionId, attemptIdentity);
  }
  const problems: string[] = [];
  const reservations = new Set(ledger.map(item => JSON.stringify([item.trialId, item.attempt])));
  // Legacy imported output collections may have no execution ledger at all.
  // Once a ledger exists, an omitted reservation is lost evidence, not an import.
  if (ledger.length) for (const artifact of artifacts) {
    if (!reservations.has(JSON.stringify([artifact.trialId, artifact.attempt]))) problems.push(`Execution artifact has no retained start reservation: ${artifact.trialId}, attempt ${artifact.attempt}`);
  }
  for (const ticket of ledger) {
    const artifact = attempts.get(JSON.stringify([ticket.trialId, ticket.attempt]));
    if (!artifact) { problems.push(`Started execution attempt has missing evidence: ${ticket.trialId}, attempt ${ticket.attempt}`); continue; }
    if (ticket.caseId !== artifact.caseId || ticket.repeat !== artifact.repeat || ticket.sessionId !== artifact.sessionId || ticket.startedAt !== artifact.startedAt) throw new Error('Execution artifact identity does not match its started-attempt ledger');
  }
  return problems;
}
const artifactWrites = new Map<string,Promise<void>>();
export async function writeArtifact(directory: string, artifact: TrialArtifact): Promise<void> {
  const file = path.join(directory, 'artifacts', `${hash(artifact.trialId)}-${artifact.attempt}.json`);
  const snapshot=structuredClone(artifact);
  validateArtifactStructure(snapshot, path.basename(file));
  const previous=artifactWrites.get(file)??Promise.resolve();
  const work=previous.then(()=>writeArtifactSnapshot(file,snapshot));
  artifactWrites.set(file,work);
  try{await work;}finally{if(artifactWrites.get(file)===work)artifactWrites.delete(file);}
}
async function writeArtifactSnapshot(file:string,artifact:TrialArtifact):Promise<void> {
  try {
    const previous = await readJson<TrialArtifact>(file);
    const identity = (item: TrialArtifact) => [item.version,item.runId,item.trialId,item.caseId,item.repeat,item.attempt,item.sessionId,item.startedAt];
    if (hash(identity(previous)) !== hash(identity(artifact))) throw new Error('Execution attempt identity is immutable');
    if (previous.status !== 'running') {
      if (hash(previous) === hash(artifact)) return;
      throw new Error('Completed execution attempts are immutable');
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeJson(file, artifact);
}
export async function snapshotSources(directory: string, files: SourceFile[]): Promise<void> {
  const folder = path.join(directory, 'sources');
  await mkdir(folder, {recursive: true});
  for (const source of files) {
    const bytes = await readFile(source.path);
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error(`Source changed: ${source.path}`);
    await writeFile(path.join(folder, source.sha256), bytes, {mode:0o600});
  }
}
export async function withRunLock<T>(directory: string, callback: () => Promise<T>): Promise<T> {
  await mkdir(directory, {recursive:true});
  const release=await lockfile.lock(directory,{lockfilePath:path.join(directory,'.one-eval.lock'),stale:30_000,update:5_000,retries:0});
  try { return await callback(); }
  finally { await release(); }
}
