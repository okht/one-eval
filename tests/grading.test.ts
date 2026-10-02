import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gradeEvaluation, readGradeRecords, parseGradeValue, readGradingState, validatePreparedGrading } from '../src/grading.js';
import { buildReport } from '../src/report.js';
import { hash, fileHash, writeJson, writeArtifact } from '../src/storage.js';
import type { EvalCase, JudgeConfig, PreparedGrading, RunManifest, TrialArtifact } from '../src/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { cases?: EvalCase[]; repeats?: number; output?: string } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-grading-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = options.cases ?? [{ id: 'empty', input: 'Answer the question', reference: '', weight: 1 }];
  const plan = {
    version: 1 as const, name: 'Saved output fixture', cases,
    target: { kind: 'module' as const, path: path.join(directory, 'must-not-load.mjs'), isolation: { mode: 'stateless' as const, scope: 'independent' as const, evidence: 'Fixture records were produced independently' }, retrySafe: false },
    execution: { repeats: options.repeats ?? 1, concurrency: 1, timeoutMs: 1000 },
  };
  await writeFile(plan.target.path, 'throw new Error("The target must never load during grading or reporting");\n');
  const files = [{ path: plan.target.path, sha256: await fileHash(plan.target.path) }];
  const manifest: RunManifest = { version: 1, runId: 'saved-fixture', createdAt: new Date().toISOString(), prepared: { plan, files, baseDir: directory, planHash: hash({ plan, files }) }, engine: { name: 'promptfoo', version: '0.123.1' } };
  await writeJson(path.join(directory, 'manifest.json'), manifest);
  await writeJson(path.join(directory, 'state.json'), { blocked: false, updatedAt: manifest.createdAt });
  for (const evalCase of cases) for (let repeat = 0; repeat < plan.execution.repeats; repeat++) {
    const artifact: TrialArtifact = {
      version: 1, runId: manifest.runId, trialId: `${evalCase.id}-${repeat}`, caseId: evalCase.id, repeat, attempt: 1,
      sessionId: `${evalCase.id}-${repeat}-session`, startedAt: manifest.createdAt, finishedAt: manifest.createdAt,
      status: 'completed', output: options.output ?? '', messages: [{ role: 'user', content: evalCase.input }, { role: 'assistant', content: options.output ?? '' }],
    };
    artifact.outputHash = hash({ output: artifact.output, messages: artifact.messages, metadata: artifact.metadata });
    await writeArtifact(directory, artifact);
  }
  return { directory, manifest };
}

async function grader(directory: string, body: string, judges: Partial<JudgeConfig>[] = [{}], timeoutMs = 5000): Promise<PreparedGrading> {
  const script = path.join(directory, `grader-${hash(body).slice(0, 16)}.mjs`);
  await writeFile(script, `import fs from 'node:fs';\nconst input = JSON.parse(fs.readFileSync(0, 'utf8'));\n${body}\n`);
  const plan = {
    version: 1 as const,
    judges: judges.map((item, index) => ({ id: `judge-${index}`, kind: 'command' as const, repeats: 1, weight: 1, command: process.execPath, args: [script], ...item })),
    concurrency: 2, timeoutMs,
  };
  const files = [{ path: script, sha256: await fileHash(script) }];
  return { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
}

test('regrading saved empty outputs never loads the target and skips completed grade records', async (t) => {
  const { directory, manifest } = await fixture(t);
  const prepared = await grader(directory, 'if (input.artifact.output !== "") throw new Error("Empty output lost"); console.log(JSON.stringify({status:"scored",score:1,reason:"Empty output was preserved"}));');
  // A changed target source is irrelevant to independent grading of stored evidence.
  await writeFile(manifest.prepared.plan.target.path!, 'throw new Error("Changed target must also stay unloaded");');
  const first = await gradeEvaluation(directory, prepared) as any;
  assert.equal(first.scored, 1);
  assert.equal(first.missing, 0);
  const recordPath = path.join(directory, 'grades', prepared.versionHash, 'records');
  const before = await readdir(recordPath);
  const content = await readFile(path.join(recordPath, before[0]!), 'utf8');
  await gradeEvaluation(directory, prepared, { retryErrors: true });
  assert.deepEqual(await readdir(recordPath), before);
  assert.equal(await readFile(path.join(recordPath, before[0]!), 'utf8'), content);
  const report = await buildReport(directory) as any;
  assert.equal(report.overall, 1);
  assert.equal(report.complete, true);
});

test('report averages judge repeats first, then judge weights, execution repeats, and case weights', async (t) => {
  const { directory } = await fixture(t, {
    cases: [{ id: 'a', input: 'A', weight: 1 }, { id: 'b', input: 'B', weight: 3 }], repeats: 2,
  });
  const prepared = await grader(directory, 'const score = input.case.id === "a" ? (input.judgeId === "judge-0" ? input.repeat * 0.4 + input.artifact.repeat * 0.2 : 1) : 0.2; console.log(JSON.stringify({status:"scored",score,reason:"Deterministic test grade"}));', [{ repeats: 2, weight: 1 }, { repeats: 1, weight: 3 }]);
  const summary = await gradeEvaluation(directory, prepared) as any;
  assert.equal(summary.scored, 12);
  const report = await buildReport(directory) as any;
  assert.equal(report.cases[0].executions[0].judges[0].score, 0.2);
  assert.equal(report.cases[0].executions[0].score, 0.8);
  assert.ok(Math.abs(report.cases[0].score - 0.825) < 1e-10);
  assert.ok(Math.abs(report.overall - 0.35625) < 1e-10);
  assert.deepEqual(report.gradeCoverage, { expected: 12, scored: 12, abstained: 0, insufficientEvidence: 0, errors: 0, missing: 0 });
});

test('missing grades and missing artifacts remain in manifest denominators and never reweight overall', async (t) => {
  const { directory } = await fixture(t, { repeats: 2 });
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));', [{ repeats: 2 }]);
  await gradeEvaluation(directory, prepared);
  const records = await readGradeRecords(directory, prepared.versionHash);
  const missing = records.find((record) => record.trialId === 'empty-0')!;
  await rm(path.join(directory, 'grades', prepared.versionHash, 'records', `${missing.id}.json`));
  let report = await buildReport(directory) as any;
  assert.equal(report.overall, null);
  assert.equal(report.gradeCoverage.expected, 4);
  assert.equal(report.gradeCoverage.missing, 1);
  assert.equal(report.cases[0].executions[0].judges[0].score, null);
  assert.equal(report.cases[0].executions[0].judges[0].observed.mean, 1);
  await rm(path.join(directory, 'artifacts', `${hash('empty-1')}-1.json`));
  report = await buildReport(directory) as any;
  assert.equal(report.executionCoverage.expected, 2);
  assert.equal(report.executionCoverage.missing, 1);
  assert.equal(report.gradeCoverage.expected, 4);
  assert.equal(report.gradeCoverage.missing, 3);
  assert.equal(report.overall, null);
});

test('abstained, insufficient evidence, and zero scores retain distinct statuses', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'const result = input.judgeId === "zero" ? {status:"scored",score:0,reason:"Incorrect"} : {status:input.judgeId,reason:"No basis to score"};console.log(JSON.stringify(result));', [{ id: 'zero' }, { id: 'abstained' }, { id: 'insufficient_evidence' }]);
  await gradeEvaluation(directory, prepared);
  const report = await buildReport(directory) as any;
  assert.equal(report.overall, null);
  assert.deepEqual(report.gradeCoverage, { expected: 3, scored: 1, abstained: 1, insufficientEvidence: 1, errors: 0, missing: 0 });
  assert.equal(report.cases[0].executions[0].judges[0].score, 0);
});

test('grader errors are terminal until explicit retry and a retry appends a new attempt', async (t) => {
  const { directory } = await fixture(t);
  const marker = path.join(directory, 'failure-marker');
  const prepared = await grader(directory, `const marker = ${JSON.stringify(marker)}; if (!fs.existsSync(marker)) {fs.writeFileSync(marker,"failed");process.exit(2);} console.log(JSON.stringify({status:"scored",score:0.7,reason:"Recovered"}));`);
  assert.equal((await gradeEvaluation(directory, prepared) as any).errors, 1);
  assert.equal((await gradeEvaluation(directory, prepared) as any).errors, 1);
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 1);
  assert.equal((await gradeEvaluation(directory, prepared, { retryErrors: true }) as any).scored, 1);
  const records = await readGradeRecords(directory, prepared.versionHash);
  assert.deepEqual(records.map((record) => record.attempt).sort(), [1, 2]);
  assert.equal((await buildReport(directory) as any).overall, 0.7);
});

test('command graders are bounded and report errors without treating them as zero scores', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'setInterval(() => {}, 1000);', [{}], 100);
  const start = Date.now();
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.errors, 1);
  assert.ok(Date.now() - start < 10_000);
  const report = await buildReport(directory) as any;
  assert.equal(report.overall, null);
  assert.equal(report.gradeCoverage.errors, 1);
  assert.equal(report.gradeCoverage.scored, 0);
});

test('tampered execution evidence blocks grading and makes report incomplete', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await gradeEvaluation(directory, prepared);
  const file = path.join(directory, 'artifacts', `${hash('empty-0')}-1.json`);
  const artifact = JSON.parse(await readFile(file, 'utf8')) as TrialArtifact;
  artifact.output = 'tampered';
  await writeJson(file, artifact);
  await assert.rejects(gradeEvaluation(directory, prepared), /hash mismatch/);
  const report = await buildReport(directory) as any;
  assert.equal(report.overall, null);
  assert.equal(report.executionCoverage.invalid, 1);
  assert.equal(report.gradeCoverage.missing, 1);
});

test('multiple grading versions require explicit selection and each uses its own rules', async (t) => {
  const { directory } = await fixture(t);
  const first = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:0.2,reason:"v1"}));');
  const second = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:0.8,reason:"v2"}));');
  await gradeEvaluation(directory, first);
  await gradeEvaluation(directory, second);
  await assert.rejects(buildReport(directory), /Multiple grading versions/);
  assert.equal((await buildReport(directory, first.versionHash) as any).overall, 0.2);
  assert.equal((await buildReport(directory, second.versionHash) as any).overall, 0.8);
});

test('grading source changes cannot silently alter the current version', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await writeFile(prepared.files[0]!.path, 'process.exit(0);');
  await assert.rejects(gradeEvaluation(directory, prepared), /Source changed/);
});

test('score schema rejects invalid scales and score-bearing abstentions', () => {
  assert.throws(() => parseGradeValue({ status: 'scored', score: 99, reason: 'Wrong scale' }), /0 to 1/);
  assert.throws(() => parseGradeValue({ status: 'abstained', score: 0, reason: 'Unavailable' }), /cannot include/);
  assert.throws(() => parseGradeValue({ status: 'scored', score: 0.5, reason: '' }), /reason/);
});

test('authentication failures pause grading until explicit retry without losing completed records', async (t) => {
  const { directory } = await fixture(t, { repeats: 3 });
  const marker = path.join(directory, 'auth-marker');
  const prepared = await grader(directory, `const marker=${JSON.stringify(marker)};if (!fs.existsSync(marker)) {fs.writeFileSync(marker,"failed"); console.error("401 Unauthorized");process.exit(1);}console.log(JSON.stringify({status:"scored",score:1,reason:"Authenticated"}));`);
  prepared.plan.concurrency = 1;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  let summary = await gradeEvaluation(directory, prepared) as any;
  assert.equal(summary.blocked, true);
  assert.equal(summary.recorded, 1);
  assert.equal(summary.missing, 2);
  summary = await gradeEvaluation(directory, prepared) as any;
  assert.equal(summary.recorded, 1);
  assert.equal(summary.blocked, true);
  assert.equal((await buildReport(directory) as any).blocked, true);
  summary = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  assert.equal(summary.scored, 3);
  assert.equal(summary.blocked, false);
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 4);
  assert.equal((await buildReport(directory) as any).overall, 1);
});

test('a blocked execution run cannot produce a complete overall report despite complete grading', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await gradeEvaluation(directory, prepared);
  await writeJson(path.join(directory, 'state.json'), { blocked: true, reason: 'Target close failed', updatedAt: new Date().toISOString() });
  const report = await buildReport(directory) as any;
  assert.equal(report.complete, false);
  assert.equal(report.overall, null);
  assert.equal(report.executionState.reason, 'Target close failed');
  assert.equal(report.gradeCoverage.scored, 1);
});

test('LLM graders receive fresh context and clean up each provider instance', async (t) => {
  const { directory } = await fixture(t);
  const script = path.join(directory, 'mock-llm-grader.mjs');
  const calls = path.join(directory, 'llm-calls.jsonl');
  await writeFile(script, `import fs from 'node:fs';
export default class MockGrader {
  constructor(options) { this.config=options.config; }
  id() {return 'mock-grader';}
  async callApi(prompt, context, options) {
    const messages=JSON.parse(prompt);
    if(messages.length!==2 || messages[0].role!=='system' || messages[1].role!=='user') throw new Error('Unexpected grading context');
    if(!options.abortSignal) throw new Error('Missing abort signal');
    fs.appendFileSync(this.config.calls, JSON.stringify({type:'call',repeat:JSON.parse(messages[1].content).repeat})+'\\n');
    return {output:JSON.stringify({status:'scored',score:0.6,reason:'Fresh context'}),cost:0.003,tokenUsage:{prompt:11,completion:5,total:16,details:{reasoning:undefined}}};
  }
  async cleanup() {fs.appendFileSync(this.config.calls,JSON.stringify({type:'cleanup'})+'\\n');}
}`);
  const plan = { version: 1 as const, concurrency: 1, timeoutMs: 5000, judges: [{ id: 'llm', kind: 'llm' as const, provider: { id: `file://${script}`, config: { calls } }, prompt: 'Score the output.', repeats: 2, weight: 1 }] };
  const files = [{ path: script, sha256: await fileHash(script) }];
  const prepared = { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
  const summary = await gradeEvaluation(directory, prepared) as any;
  assert.equal(summary.scored, 2);
  const records = await readGradeRecords(directory, prepared.versionHash);
  for (const record of records) {
    assert.deepEqual(record.usage, { cost: 0.003, tokenUsage: { prompt: 11, completion: 5, total: 16, details: {} } });
    assert.ok(record.durationMs! >= 0);
    assert.equal(JSON.parse(record.rawOutput!).reason, 'Fresh context');
    assert.equal(record.rawOutputTruncated, false);
  }
  const events = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events, [{ type: 'call', repeat: 0 }, { type: 'cleanup' }, { type: 'call', repeat: 1 }, { type: 'cleanup' }]);
});

async function llmGrader(directory: string, body: string, cleanup = '', limits: Partial<PreparedGrading['plan']> = {}): Promise<PreparedGrading> {
  const script = path.join(directory, `llm-grader-${hash([body, cleanup]).slice(0, 16)}.mjs`);
  await writeFile(script, `export default class Grader { id() { return 'fixture-grader'; } async callApi(prompt) { const input=JSON.parse(JSON.parse(prompt)[1].content); ${body} } async cleanup() { ${cleanup} } }`);
  const plan = { version: 1 as const, concurrency: 1, timeoutMs: 5000, judges: [{ id: 'llm', kind: 'llm' as const, provider: `file://${script}`, repeats: 1, weight: 1 }], ...limits };
  const files = [{ path: script, sha256: await fileHash(script) }];
  return { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
}

test('malformed LLM grades retain billed usage, bounded raw evidence and structured errors', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await llmGrader(directory, `return {output:'not-json '+ '🙂'.repeat(20000), cost:0.02, tokenUsage:{total:12}};`);
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.errors, 1);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.diagnostic!.code, 'invalid_output');
  assert.equal(record!.diagnostic!.retryable, false);
  assert.deepEqual(record!.usage, { cost: 0.02, tokenUsage: { total: 12 } });
  assert.equal(record!.rawOutputTruncated, true);
  assert.ok(Buffer.byteLength(record!.rawOutput!) <= 16 * 1024);
  assert.ok(!record!.rawOutput!.includes('\uFFFD'));
  assert.ok(record!.durationMs! >= 0);
});

test('provider and cleanup failures survive together without hiding the original error or leaking secrets', async (t) => {
  const { directory } = await fixture(t, { repeats: 3 });
  const prepared = await llmGrader(directory,
    `throw new Error('Provider request failed', {cause:Object.assign(new Error('api_key=private-key Too many requests'),{code:'provider-quota',status:429})});`,
    `throw new Error('cleanup refused Authorization: Bearer private-token');`);
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.blocked, true);
  assert.equal(result.recorded, 1);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.diagnostic!.code, 'rate_limit');
  assert.equal(record!.diagnostic!.causeCode, 'provider-quota');
  assert.equal(record!.diagnostic!.statusCode, 429);
  assert.equal(record!.cleanupDiagnostic!.code, 'cleanup_failed');
  assert.equal(record!.usage, undefined);
  assert.ok(!JSON.stringify(record).includes('private-key'));
  assert.ok(!JSON.stringify(record).includes('private-token'));
  assert.equal((await gradeEvaluation(directory, prepared) as any).recorded, 1);
});

test('provider error responses retain response status, error codes and known billed cost', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await llmGrader(directory, `return {error:'Request rejected',status:429,code:'provider-limit',cost:0.01};`);
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.diagnostic!.code, 'rate_limit');
  assert.equal(record!.diagnostic!.causeCode, 'provider-limit');
  assert.equal(record!.diagnostic!.statusCode, 429);
  assert.deepEqual(record!.usage, { cost: 0.01 });
});

test('command errors have duration and stable diagnostics while unknown usage stays absent', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, `console.error('failed api_key=private-key');process.exit(2);`);
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.diagnostic!.code, 'process_exit');
  assert.equal(record!.diagnostic!.causeCode, 'PROCESS_EXIT');
  assert.equal(record!.usage, undefined);
  assert.ok(record!.durationMs! >= 0);
  assert.ok(!record!.reason.includes('private-key'));
});

test('grading attempt limits reserve across workers and count failed retries across resumes', async (t) => {
  const { directory } = await fixture(t, { repeats: 5 });
  const prepared = await grader(directory, 'process.exit(2);');
  prepared.plan.concurrency = 4;
  prepared.plan.maxAttempts = 2;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  const first = await gradeEvaluation(directory, prepared) as any;
  assert.equal(first.recorded, 2);
  assert.equal(first.errors, 2);
  assert.equal(first.missing, 3);
  assert.equal(first.limitReached, true);
  assert.equal(first.blocked, false);
  assert.match(first.limitReason, /attempt limit/);
  const second = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  assert.equal(second.recorded, 2);
  assert.equal(second.limitReached, true);
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 2);
});

test('durable grade reservations survive a lost completion record and cannot replenish the attempt cap', async (t) => {
  const { directory } = await fixture(t);
  const log = path.join(directory, 'grade-invocations.log');
  const prepared = await grader(directory, `
    const attemptRoot = ${JSON.stringify(path.join(directory, 'grades'))};
    const version = fs.readdirSync(attemptRoot)[0];
    if (fs.readdirSync(attemptRoot + '/' + version + '/attempts').length !== 1) throw new Error('Dispatch happened before durable reservation');
    fs.appendFileSync(${JSON.stringify(log)}, 'called\\n');
    console.log(JSON.stringify({status:'scored',score:1,reason:'ok'}));`);
  prepared.plan.maxAttempts = 1;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  await gradeEvaluation(directory, prepared);
  const [completed] = await readGradeRecords(directory, prepared.versionHash);
  // This is the on-disk state of a crash after the command ran but before final record persistence.
  await rm(path.join(directory, 'grades', prepared.versionHash, 'records', `${completed!.id}.json`));
  const recovered = await gradeEvaluation(directory, prepared) as any;
  assert.equal(recovered.blocked, true);
  assert.equal(recovered.errors, 1);
  const [interrupted] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(interrupted!.diagnostic!.code, 'interrupted');
  assert.equal(interrupted!.usage, undefined);
  const retry = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  assert.equal(retry.blocked, false);
  assert.equal(retry.limitReached, true);
  assert.equal(retry.errors, 1);
  assert.equal(await readFile(log, 'utf8'), 'called\n');
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 1);
});

test('explicit retry after an interrupted grade appends a new attempt when budget remains', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  prepared.plan.maxAttempts = 2;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  await gradeEvaluation(directory, prepared);
  const [completed] = await readGradeRecords(directory, prepared.versionHash);
  await rm(path.join(directory, 'grades', prepared.versionHash, 'records', `${completed!.id}.json`));
  const result = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  assert.equal(result.scored, 1);
  const records = (await readGradeRecords(directory, prepared.versionHash)).sort((left, right) => left.attempt - right.attempt);
  assert.deepEqual(records.map((record) => [record.attempt, record.status]), [[1, 'grading_error'], [2, 'scored']]);
  assert.equal(records[0]!.diagnostic!.code, 'interrupted');
  assert.equal((await gradeEvaluation(directory, prepared) as any).blocked, false);
});

test('grading start interval applies across concurrent workers', async (t) => {
  const { directory } = await fixture(t, { repeats: 3 });
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  prepared.plan.concurrency = 3;
  prepared.plan.minIntervalMs = 70;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  await gradeEvaluation(directory, prepared);
  const starts = (await readGradeRecords(directory, prepared.versionHash)).map((record) => Date.parse(record.createdAt)).sort();
  assert.equal(starts.length, 3);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index]! - starts[index - 1]! >= 60);
});

test('observed-cost threshold stops later grades and persists across resumes', async (t) => {
  const { directory } = await fixture(t, { repeats: 4 });
  const prepared = await llmGrader(directory, `return {output:{status:'scored',score:1,reason:'ok'},cost:0.2};`, '', { maxCost: 0.3 });
  const first = await gradeEvaluation(directory, prepared) as any;
  assert.equal(first.scored, 2);
  assert.equal(first.limitReached, true);
  assert.equal(first.blocked, false);
  assert.match(first.limitReason, /in-flight requests may exceed/);
  const second = await gradeEvaluation(directory, prepared) as any;
  assert.equal(second.scored, 2);
  assert.equal(second.limitReached, true);
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 2);
});

test('cost guard treats missing provider cost as unknown and keeps the completed grade', async (t) => {
  const { directory } = await fixture(t, { repeats: 3 });
  const prepared = await llmGrader(directory, `return {output:{status:'scored',score:1,reason:'ok'},tokenUsage:{total:10}};`, '', { maxCost: 1 });
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.scored, 1);
  assert.equal(result.limitReached, true);
  assert.match(result.limitReason, /cost unavailable/);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.usage!.cost, undefined);
  assert.equal((await gradeEvaluation(directory, prepared) as any).recorded, 1);
});

test('cost guard cannot silently claim coverage for command graders', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  prepared.plan.maxCost = 1;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.recorded, 0);
  assert.equal(result.limitReached, true);
  assert.equal(result.blocked, false);
  assert.match(result.limitReason, /cannot cover command graders/);
});

test('adversarial: non-cooperative grader timeout quarantines active work before cleanup or retry', async (t) => {
  const { directory } = await fixture(t, { repeats: 2 });
  const events = path.join(directory, 'lifecycle.jsonl');
  const script = path.join(directory, 'noncooperative.mjs');
  await writeFile(script, `import fs from 'node:fs';
const log=(event)=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(event)+'\\n');
export default class Grader { id(){return 'noncooperative';}
async callApi(){this.active=true;log('start');await new Promise(r=>setTimeout(r,180));this.active=false;log('settled');return {output:{status:'scored',score:1,reason:'late'},cost:0.2};}
async cleanup(){log(this.active?'cleanup-raced':'cleanup');}}
`);
  const plan = { version: 1 as const, concurrency: 1, timeoutMs: 20, judges: [{ id: 'llm', kind: 'llm' as const, provider: `file://${script}`, repeats: 1, weight: 1 }] };
  const files = [{ path: script, sha256: await fileHash(script) }];
  const prepared = { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
  const first = await gradeEvaluation(directory, prepared) as any;
  const retry = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const observed = (await readFile(events, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(first.blocked, true);
  assert.equal(first.recorded, 1);
  assert.equal(retry.blocked, true);
  assert.deepEqual(observed, ['start', 'settled', 'cleanup']);
});

test('adversarial: settled late grader responses retain billed usage but never become scores', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await llmGrader(directory, `await new Promise(r=>setTimeout(r,65));return {output:{status:'scored',score:1,reason:'late'},cost:0.3,tokenUsage:{total:9}};`, '', { timeoutMs: 50 });
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  assert.equal(record!.status, 'grading_error');
  assert.equal(record!.diagnostic!.code, 'timeout');
  assert.deepEqual(record!.usage, { cost: 0.3, tokenUsage: { total: 9 } });
});

test('adversarial: grading rejects unsigned case identity corruption in completed records', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  record!.caseId = 'unrelated-case';
  await writeJson(path.join(directory, 'grades', prepared.versionHash, 'records', `${record!.id}.json`), record);
  await assert.rejects(gradeEvaluation(directory, prepared), /case|identity/i);
});

test('adversarial: interrupted reservation must bind to the saved execution case', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  const attemptPath = path.join(directory, 'grades', prepared.versionHash, 'attempts', `${record!.id}.json`);
  const reservation = JSON.parse(await readFile(attemptPath, 'utf8'));
  reservation.caseId = 'another-case';
  await writeJson(attemptPath, reservation);
  await rm(path.join(directory, 'grades', prepared.versionHash, 'records', `${record!.id}.json`));
  await assert.rejects(gradeEvaluation(directory, prepared), /case|identity/i);
});

test('adversarial: negative recorded usage cannot reduce a resumed cost budget', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await llmGrader(directory, `return {output:{status:'scored',score:1,reason:'ok'},cost:0.3};`);
  await gradeEvaluation(directory, prepared);
  const [record] = await readGradeRecords(directory, prepared.versionHash);
  record!.usage = { cost: -100 };
  await writeJson(path.join(directory, 'grades', prepared.versionHash, 'records', `${record!.id}.json`), record);
  await assert.rejects(readGradeRecords(directory, prepared.versionHash), /cost|usage/i);
});

test('adversarial: unsupported grading manifest versions cannot be resumed', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ok"}));');
  await gradeEvaluation(directory, prepared);
  const file = path.join(directory, 'grades', prepared.versionHash, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.version = 99;
  await writeJson(file, manifest);
  await assert.rejects(gradeEvaluation(directory, prepared), /manifest/i);
});

test('adversarial: a hanging cleanup quarantines explicit retries until actual settlement', async (t) => {
  const { directory } = await fixture(t, { repeats: 2 });
  const calls = path.join(directory, 'cleanup-events.jsonl');
  const script = path.join(directory, 'slow-cleanup.mjs');
  await writeFile(script, `import fs from 'node:fs';const log=x=>fs.appendFileSync(${JSON.stringify(calls)},x+'\\n');
export default class Grader { id(){return 'slow-cleanup';}async callApi(){log('call');return {output:{status:'scored',score:1,reason:'ok'}};}
async cleanup(){log('cleanup-start');await new Promise(r=>setTimeout(r,180));log('cleanup-finish');}}
`);
  const plan = { version: 1 as const, concurrency: 1, timeoutMs: 20, judges: [{ id: 'llm', kind: 'llm' as const, provider: `file://${script}`, repeats: 1, weight: 1 }] };
  const files = [{ path: script, sha256: await fileHash(script) }];
  const prepared = { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
  const result = await gradeEvaluation(directory, prepared) as any;
  const retry = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(result.blocked, true);
  assert.equal(retry.blocked, true);
  assert.equal(retry.recorded, 1);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), ['call', 'cleanup-start', 'cleanup-finish']);
});

test('adversarial: multi-worker authentication failure retains in-flight successes and stops new admissions', async (t) => {
  const { directory } = await fixture(t, { repeats: 8 });
  const prepared = await llmGrader(directory, `if(input.artifact.repeat===0){await new Promise(r=>setTimeout(r,15));return {error:'401 Unauthorized'};}await new Promise(r=>setTimeout(r,80));return {output:{status:'scored',score:1,reason:'in-flight success'},cost:0.1};`, '', { concurrency: 3 });
  const result = await gradeEvaluation(directory, prepared) as any;
  assert.equal(result.blocked, true);
  assert.equal(result.errors, 1);
  assert.equal(result.scored, 2);
  assert.equal(result.recorded, 3);
  const before = await readGradeRecords(directory, prepared.versionHash);
  assert.equal((await gradeEvaluation(directory, prepared) as any).recorded, 3);
  assert.deepEqual(await readGradeRecords(directory, prepared.versionHash), before);
});

test('adversarial: failed provider attempts retain costs in resumed budget accounting', async (t) => {
  const { directory } = await fixture(t, { repeats: 4 });
  const prepared = await llmGrader(directory, `return input.artifact.repeat===0?{error:'Temporary service error',cost:0.2}:{output:{status:'scored',score:1,reason:'ok'},cost:0.2};`, '', { maxCost: 0.3 });
  const first = await gradeEvaluation(directory, prepared) as any;
  assert.equal(first.errors, 1);
  assert.equal(first.scored, 1);
  assert.equal(first.limitReached, true);
  const before = await readGradeRecords(directory, prepared.versionHash);
  const retry = await gradeEvaluation(directory, prepared, { retryErrors: true }) as any;
  assert.equal(retry.limitReached, true);
  assert.deepEqual(await readGradeRecords(directory, prepared.versionHash), before);
  assert.equal(before.reduce((sum, record) => sum + record.usage!.cost!, 0), 0.4);
});

test('adversarial: deterministic randomized budgets preserve successful slots and cap retries', async (t) => {
  let seed = 0x13579;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 6; trial++) {
    const { directory } = await fixture(t, { repeats: 7 });
    const cap = 4 + next() % 7;
    const concurrency = 1 + next() % 4;
    const prepared = await llmGrader(directory, `await new Promise(r=>setTimeout(r,(input.artifact.repeat*7)%13));return input.artifact.repeat%3===0?{error:'Fixture transient failure',cost:0.01}:{output:{status:'scored',score:input.artifact.repeat/10,reason:'fixed result'},cost:0.01};`, '', { concurrency, maxAttempts: cap });
    await gradeEvaluation(directory, prepared);
    const first = await readGradeRecords(directory, prepared.versionHash);
    const successful = first.filter((record) => record.status === 'scored');
    for (let retry = 0; retry < 3; retry++) await gradeEvaluation(directory, prepared, { retryErrors: true });
    const all = await readGradeRecords(directory, prepared.versionHash);
    assert.ok(all.length <= cap, `seed trial ${trial}: ${all.length} > ${cap}`);
    assert.equal(new Set(all.map((record) => record.id)).size, all.length);
    for (const record of successful) assert.deepEqual(all.find((item) => item.id === record.id), record);
    for (const record of all.filter((item) => item.status === 'scored')) assert.equal(all.filter((item) => item.trialId === record.trialId).length, 1);
    const latest = new Map<string, number[]>();
    for (const record of all) latest.set(record.trialId, [...latest.get(record.trialId) ?? [], record.attempt]);
    for (const attempts of latest.values()) assert.deepEqual(attempts.sort((a,b)=>a-b), Array.from({length:attempts.length},(_,index)=>index+1));
  }
});

test('adversarial: rehashed prepared grading respects configured count and timeout bounds', async (t) => {
  const { directory } = await fixture(t);
  const prepared = await grader(directory, 'process.exit(0);');
  for (const patch of [{ concurrency: 101 }, { timeoutMs: 3_600_001 }, { minIntervalMs: 60_001 }, { maxAttempts: 1_000_001 }]) {
    const mutated = structuredClone(prepared);
    Object.assign(mutated.plan, patch);
    mutated.versionHash = hash({ plan: mutated.plan, files: mutated.files });
    assert.throws(() => validatePreparedGrading(mutated), /grading/i);
  }
  prepared.plan.judges[0]!.repeats = Number.MAX_SAFE_INTEGER;
  prepared.versionHash = hash({ plan: prepared.plan, files: prepared.files });
  assert.throws(() => validatePreparedGrading(prepared), /grading|judge/i);
});

test('adversarial: malformed grading state cannot silently clear a persisted block', async (t) => {
  const { directory } = await fixture(t);
  const version = 'a'.repeat(64);
  await writeJson(path.join(directory, 'grades', version, 'state.json'), { blocked: 0, updatedAt: new Date().toISOString() });
  await assert.rejects(readGradingState(directory, version), /state/i);
});

test('adversarial: a live quarantine owner blocks another process until the owner exits', { timeout: 30_000 }, async (t) => {
  const { directory } = await fixture(t);
  const calls = path.join(directory, 'cross-process-calls.jsonl');
  const release = path.join(directory, 'release-provider');
  const provider = path.join(directory, 'cross-process-provider.mjs');
  await writeFile(provider, `import fs from 'node:fs';export default class Grader {id(){return 'cross-process';}
async callApi(){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({pid:process.pid})+'\\n');while(!fs.existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));return {output:{status:'scored',score:1,reason:'released'}};}async cleanup(){}}
`);
  const plan = { version: 1 as const, concurrency: 1, timeoutMs: 30, judges: [{ id: 'llm', kind: 'llm' as const, provider: `file://${provider}`, repeats: 1, weight: 1 }] };
  const files = [{ path: provider, sha256: await fileHash(provider) }];
  const prepared = { plan, files, baseDir: directory, versionHash: hash({ plan, files }) };
  const preparedFile = path.join(directory, 'prepared.json');
  await writeJson(preparedFile, prepared);
  const runner = path.join(directory, 'grade-child.mjs');
  await writeFile(runner, `import fs from 'node:fs';import {gradeEvaluation} from ${JSON.stringify(new URL('../src/grading.ts', import.meta.url).href)};
const [directory,preparedFile,resultFile,mode]=process.argv.slice(2);const prepared=JSON.parse(fs.readFileSync(preparedFile,'utf8'));
try{const result=await gradeEvaluation(directory,prepared,{retryErrors:mode!=='owner'});fs.writeFileSync(resultFile,JSON.stringify(result));}catch(error){fs.writeFileSync(resultFile,JSON.stringify({error:error.message}));}
if(mode==='owner')setInterval(()=>{},1000);else process.exit(0);
`);
  const children: ReturnType<typeof spawn>[] = [];
  const start = (mode: string, result: string) => {
    const child = spawn(process.execPath, ['--import', 'tsx', runner, directory, preparedFile, result, mode], { cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    return child;
  };
  const waitJson = async (file: string) => {
    for (let index = 0; index < 150; index++) {
      try { return JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Child grading result was not produced');
  };
  const close = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    await exited;
  };
  try {
    const firstResult = path.join(directory, 'owner-result.json');
    const owner = start('owner', firstResult);
    assert.equal((await waitJson(firstResult)).blocked, true);
    const secondResult = path.join(directory, 'other-result.json');
    const retry = start('retry', secondResult);
    const second = await waitJson(secondResult);
    assert.equal(second.blocked, true);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 1, 'Another process dispatched a duplicate while the owner was alive');
    assert.equal((await readGradingState(directory, prepared.versionHash) as any).activeProcess, owner.pid);
    await close(retry);
    await close(owner);
    await writeFile(release, 'ready');
    const recoveredResult = path.join(directory, 'recovered-result.json');
    start('retry', recoveredResult);
    const recovered = await waitJson(recoveredResult);
    assert.equal(recovered.blocked, false);
    assert.equal(recovered.scored, 1);
    assert.deepEqual((await readGradeRecords(directory, prepared.versionHash)).map((record) => record.attempt).sort(), [1, 2]);
    assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 2);
  } finally { for (const child of children) await close(child); }
});

test('adversarial: a newer execution reservation blocks grading of an older saved answer', async (t) => {
  const { directory } = await fixture(t);
  const file = path.join(directory, 'artifacts', `${hash('empty-0')}-1.json`);
  const original = JSON.parse(await readFile(file, 'utf8')) as TrialArtifact;
  const oldTicket = { ...original, status: 'running', output: undefined, outputHash: undefined, finishedAt: undefined };
  const newTicket = { ...oldTicket, attempt: 2, sessionId: 'newer-session', startedAt: new Date().toISOString() };
  await writeJson(path.join(directory, 'attempts', `${hash(original.trialId)}-1.json`), oldTicket);
  await writeJson(path.join(directory, 'attempts', `${hash(original.trialId)}-2.json`), newTicket);
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"stale"}));');
  await assert.rejects(gradeEvaluation(directory, prepared), /missing evidence|execution evidence/i);
  assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 0);
});

test('adversarial: foreign failed execution evidence cannot be silently ignored by grading', async (t) => {
  const { directory } = await fixture(t);
  const artifact = JSON.parse(await readFile(path.join(directory, 'artifacts', `${hash('empty-0')}-1.json`), 'utf8')) as TrialArtifact;
  await writeArtifact(directory, { ...artifact, runId: 'foreign-run', trialId: 'foreign-trial', attempt: 2, sessionId: 'foreign-session', status: 'execution_error', error: 'failed', output: undefined, outputHash: undefined });
  const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"ignored foreign failure"}));');
  await assert.rejects(gradeEvaluation(directory, prepared), /identity|does not belong|different run/i);
});

test('adversarial: completed grades require successful isolation and cleanup evidence', async (t) => {
  for (const patch of [{ isolation: { ok: false, evidence: 'Failed reset' } }, { cleanupError: 'Cleanup failed' }, { error: 'Execution failed' }]) {
    const { directory } = await fixture(t);
    const file = path.join(directory, 'artifacts', `${hash('empty-0')}-1.json`);
    const artifact = JSON.parse(await readFile(file, 'utf8')) as TrialArtifact;
    await writeJson(file, { ...artifact, ...patch });
    const prepared = await grader(directory, 'console.log(JSON.stringify({status:"scored",score:1,reason:"invalid completion"}));');
    await assert.rejects(gradeEvaluation(directory, prepared), /isolation|cleanup|contradictory|failure/i);
    assert.equal((await readGradeRecords(directory, prepared.versionHash)).length, 0);
  }
});
