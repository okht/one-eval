// Audit completed one-eval reports without combining unrelated benchmark scores.
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
const { values, positionals: directories } = parseArgs({ allowPositionals: true, options: { out: { type: 'string', default: 'results/expanded-20261002.json' } } });
if (!directories.length) throw new Error('Supply completed run directories.');
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const allSessions = new Set(), allThreads = new Set(), datasets = [];
let totalModelTurns = 0, observedToolCalls = 0, failedExecutionAttempts = 0;
for (const directory of directories) {
  const manifest = await json(path.join(directory, 'manifest.json'));
  const report = await json(path.join(directory, 'report.json'));
  assert.equal(report.complete, true, `${directory} is incomplete`);
  const artifactPaths = new Map();
  const attempts = await Promise.all((await readdir(path.join(directory, 'artifacts'))).filter(f => f.endsWith('.json')).map(async f => {
    const file = path.resolve(directory, 'artifacts', f), artifact = await json(file);
    artifactPaths.set(`${artifact.trialId}:${artifact.attempt}`, file); return artifact;
  }));
  const latest = new Map();
  for (const a of attempts) {
    assert.equal(allSessions.has(a.sessionId), false); allSessions.add(a.sessionId);
    if (!latest.has(a.trialId) || latest.get(a.trialId).attempt < a.attempt) latest.set(a.trialId, a);
  }
  const artifacts = [...latest.values()];
  assert.equal(artifacts.length, report.executionCoverage.expected);
  const previousAttempts = attempts.filter(a => latest.get(a.trialId) !== a);
  assert.equal(previousAttempts.some(a => a.status === 'completed'), false, 'A successful response was repeated.');
  failedExecutionAttempts += previousAttempts.length;
  const cases = new Map(manifest.prepared.plan.cases.map(c => [c.id, c]));
  const tokens = { input: 0, cached: 0, output: 0 }, latencies = [];
  let turns = 0, toolCalls = 0;
  for (const a of artifacts) {
    assert.equal(a.status, 'completed'); assert.equal(a.isolation.ok, true);
    assert.deepEqual(a.messages[0], { role: 'user', content: cases.get(a.caseId).input });
    const calls = a.metadata.target.calls;
    assert.equal(calls.length, a.messages.filter(m => m.role === 'assistant').length);
    assert.equal(a.output, a.messages.at(-1).content);
    const userInputs = a.messages.filter(m => m.role === 'user').map(m => m.content);
    const evalCase = cases.get(a.caseId);
    assert.deepEqual(userInputs, [evalCase.input, ...(evalCase.conversation?.turns ?? [])]);
    for (const { metadata: m } of calls) {
      assert.equal(typeof m.threadId, 'string', 'Missing CLI thread evidence.');
      assert.equal(allThreads.has(m.threadId), false, 'Thread reused across replay invocations.'); allThreads.add(m.threadId);
      const events = m.events;
      assert.equal(events.filter(e => e.type === 'turn.completed').length, 1);
      toolCalls += events.filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').length;
    }
    turns += calls.length;
    for (const key of Object.keys(tokens)) tokens[key] += a.metadata.target.tokenUsage?.[key] ?? 0;
    latencies.push((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000);
  }
  latencies.sort((a, b) => a - b); totalModelTurns += turns; observedToolCalls += toolCalls;
  const caseResults = report.cases.map(c => ({ caseId: c.caseId, score: c.score,
    repeatScores: c.executions.map(e => e.score), allPass: c.executions.every(e => e.score === 1), anyPass: c.executions.some(e => e.score === 1) }));
  const failures = report.cases.flatMap(c => c.executions.filter(e => e.score !== 1).map(e => {
    const a = artifacts.find(a => a.trialId === e.trialId);
    return { caseId: c.caseId, repeat: e.repeat + 1, score: e.score, prompt: cases.get(c.caseId).input,
      reference: cases.get(c.caseId).reference, output: a.output, artifactFile: artifactPaths.get(`${e.trialId}:${a.attempt}`),
      grades: e.judges.flatMap(j => j.grades) };
  }));
  const perRepeat = Array.from({ length: manifest.prepared.plan.execution.repeats }, (_, repeat) => ({
    repeat: repeat + 1, correct: report.cases.reduce((sum, c) => sum + c.executions.find(e => e.repeat === repeat).score, 0), total: cases.size,
  }));
  const extra = {};
  if ([...cases.keys()][0].startsWith('ifeval-')) {
    const details = report.cases.flatMap(c => c.executions.flatMap(e => e.judges.flatMap(j => j.grades.map(g => JSON.parse(g.reason)))));
    for (const mode of ['strict', 'loose']) {
      const correct = details.reduce((sum, d) => sum + d[mode].instruction_correct, 0);
      const total = details.reduce((sum, d) => sum + d[mode].instruction_total, 0);
      extra[mode] = { promptCorrect: details.reduce((sum, d) => sum + d[mode].prompt_correct, 0), promptTotal: details.length, instructionCorrect: correct, instructionTotal: total };
    }
    extra.instructionTypeCounts = {};
    for (const c of cases.values()) for (const id of c.reference.instruction_id_list) extra.instructionTypeCounts[id] = (extra.instructionTypeCounts[id] ?? 0) + 1;
  }
  if ([...cases.values()][0].reference?.revision === 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000') {
    extra.categories = {};
    for (const c of report.cases) {
      const category = cases.get(c.caseId).reference.category;
      const item = extra.categories[category] ??= { cases: 0, correct: 0, executions: 0, invalidProtocol: 0 };
      item.cases++;
      for (const e of c.executions) {
        item.executions++; item.correct += e.score;
        for (const g of e.judges.flatMap(j => j.grades)) if (!JSON.parse(g.reason).protocol_valid) item.invalidProtocol++;
      }
    }
  }
  if ([...cases.values()][0].reference?.benchmark === 'one-eval-context-isolation') {
    const details = report.cases.flatMap(c => c.executions.flatMap(e => e.judges.flatMap(j => j.grades.map(g => JSON.parse(g.reason)))));
    extra.contextChecks = { finalValueCorrect: details.filter(d => d.checks.at(-1).pass).length, total: details.length,
      blankProbesCorrect: details.filter(d => d.kind === 'cross_case_blank' && d.checks.at(-1).pass).length,
      blankProbesTotal: details.filter(d => d.kind === 'cross_case_blank').length,
      foreignTokenLeakTrials: details.filter(d => d.leakedTokens.length).length,
      exactReplyChecksCorrect: details.reduce((sum, d) => sum + d.checks.filter(c => c.pass).length, 0),
      exactReplyChecksTotal: details.reduce((sum, d) => sum + d.checks.length, 0),
    };
  }
  datasets.push({ name: manifest.prepared.plan.name, runId: report.runId, directory: path.resolve(directory), gradingVersion: report.gradingVersion,
    caseCount: cases.size, repeats: manifest.prepared.plan.execution.repeats, executions: artifacts.length, modelTurns: turns, toolCalls,
    firstAttemptCompleted: artifacts.filter(a => a.attempt === 1).length,
    failedAttempts: previousAttempts.map(a => ({ caseId: a.caseId, repeat: a.repeat + 1, attempt: a.attempt, status: a.status, error: a.error, artifactFile: artifactPaths.get(`${a.trialId}:${a.attempt}`) })),
    overall: report.overall, perRepeat, casesPassingAllRepeats: caseResults.filter(c => c.allPass).length,
    casesPassingAnyRepeat: caseResults.filter(c => c.anyPass).length,
    unstableCases: caseResults.filter(c => new Set(c.repeatScores).size > 1),
    latencySeconds: { median: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.ceil(latencies.length * .95) - 1], max: latencies.at(-1) },
    tokens, extra, failures, caseResults });
}
const summary = { version: 1, uniqueTrialSessions: allSessions.size, uniqueTargetThreads: allThreads.size,
  modelTurns: totalModelTurns, observedToolCalls, failedExecutionAttempts, datasets,
  notes: ['Scores remain separate by benchmark and protocol.', 'Repeated observations are correlated.', 'Model turns and token totals cover final completed attempts; failed CLI invocations may lack token and thread evidence.', 'Remote model hidden state and training contamination are outside this audit.'] };
const output = path.resolve(values.out); await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, ...Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'datasets')),
  datasets: datasets.map(({ name, caseCount, executions, modelTurns, toolCalls, overall, perRepeat, casesPassingAllRepeats, unstableCases }) => ({ name, caseCount, executions, modelTurns, toolCalls, overall, perRepeat, casesPassingAllRepeats, unstableCases: unstableCases.map(c => c.caseId) })) }));
