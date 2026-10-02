import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directories = process.argv.slice(2);
if (directories.length !== 2) throw new Error('Usage: node summarize.mjs <gsm8k-run> <ifeval-run>');
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const summaries = [], allThreads = new Set(), allSessions = new Set();
for (const directory of directories) {
  const manifest = await readJson(path.join(directory, 'manifest.json'));
  const report = await readJson(path.join(directory, 'report.json'));
  assert.equal(report.complete, true, 'Only complete runs can produce this smoke summary.');
  const artifacts = await Promise.all((await readdir(path.join(directory, 'artifacts'))).filter(f => f.endsWith('.json')).map(f => readJson(path.join(directory, 'artifacts', f))));
  assert.equal(artifacts.length, report.executionCoverage.expected);
  const cases = new Map(manifest.prepared.plan.cases.map(c => [c.id, c]));
  const tokens = { input: 0, cached: 0, output: 0 }, latencies = [];
  for (const artifact of artifacts) {
    assert.equal(artifact.status, 'completed');
    assert.equal(artifact.attempt, 1);
    assert.equal(artifact.isolation.ok, true);
    assert.equal(artifact.messages.length, 2);
    assert.deepEqual(artifact.messages[0], { role: 'user', content: cases.get(artifact.caseId).input });
    assert.deepEqual(artifact.messages[1], { role: 'assistant', content: artifact.output });
    const calls = artifact.metadata.target.calls;
    assert.equal(calls.length, 1);
    const call = calls[0].metadata;
    assert.equal(call.cliVersion, 'codex-cli 0.144.6');
    assert.equal(call.requestedModel, 'gpt-5.6-sol');
    assert.equal(allThreads.has(call.threadId), false, 'Target thread was reused.');
    assert.equal(allSessions.has(artifact.sessionId), false, 'Trial session was reused.');
    allThreads.add(call.threadId); allSessions.add(artifact.sessionId);
    assert.equal(call.events.filter(e => e.type === 'turn.completed').length, 1);
    assert.equal(call.events.filter(e => e.type.startsWith('item.') && !['agent_message', 'reasoning'].includes(e.item.type)).length, 0);
    for (const key of Object.keys(tokens)) tokens[key] += artifact.metadata.target.tokenUsage[key] ?? 0;
    latencies.push((Date.parse(artifact.finishedAt) - Date.parse(artifact.startedAt)) / 1000);
  }
  latencies.sort((a, b) => a - b);
  const perRepeat = Array.from({ length: manifest.prepared.plan.execution.repeats }, (_, repeat) => {
    const scores = report.cases.map(c => c.executions.find(e => e.repeat === repeat).score);
    return { repeat: repeat + 1, correct: scores.reduce((a, b) => a + b, 0), total: scores.length };
  });
  const failures = report.cases.flatMap(c => c.executions.filter(e => e.score !== 1).map(e => {
    const artifact = artifacts.find(a => a.trialId === e.trialId);
    return { caseId: c.caseId, repeat: e.repeat + 1, score: e.score, prompt: cases.get(c.caseId).input, output: artifact.output, grades: e.judges.flatMap(j => j.grades) };
  }));
  const ifeval = report.cases[0].caseId.startsWith('ifeval-');
  let officialInstructionMetrics;
  if (ifeval) {
    const details = report.cases.flatMap(c => c.executions.flatMap(e => e.judges.flatMap(j => j.grades.map(g => JSON.parse(g.reason)))));
    officialInstructionMetrics = {};
    for (const mode of ['strict', 'loose']) {
      const correct = details.reduce((sum, d) => sum + d[mode].instruction_correct, 0);
      const total = details.reduce((sum, d) => sum + d[mode].instruction_total, 0);
      officialInstructionMetrics[mode] = { correct, total, accuracy: correct / total,
        promptCorrect: details.reduce((sum, d) => sum + d[mode].prompt_correct, 0), promptTotal: details.length };
    }
  }
  summaries.push({ dataset: ifeval ? 'IFEval' : 'GSM8K', directory: path.resolve(directory), runId: report.runId,
    gradingVersion: report.gradingVersion, caseCount: cases.size, executions: artifacts.length,
    overall: report.overall, perRepeat, scoreChangedCases: report.cases.filter(c => new Set(c.executions.map(e => e.score)).size > 1).map(c => c.caseId),
    outputChangedCases: report.cases.filter(c => new Set(artifacts.filter(a => a.caseId === c.caseId).map(a => a.output)).size > 1).map(c => c.caseId),
    latencySeconds: { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], p95: latencies[Math.ceil(latencies.length * .95) - 1], max: latencies.at(-1) },
    tokens, officialInstructionMetrics, failures });
}
const summary = { version: 1, model: 'gpt-5.6-sol via Codex CLI 0.144.6',
  purpose: 'Small real-model integration smoke test; not a full benchmark or tool-using agent evaluation.',
  uniqueTargetThreads: allThreads.size, uniqueTrialSessions: allSessions.size, toolsObserved: 0,
  caveats: ['24 distinct questions; repeated calls are correlated and are not 48 independent questions.',
    'Public benchmarks may be in model training data. No claim of unseen-data quality.',
    'Remote provider hidden state cannot be independently verified.',
    'Token totals cover the recorded benchmark trials, excluding setup probes. No dollar cost estimate.'],
  datasets: summaries };
const output = path.resolve('results/open-source-smoke-20261002.json');
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ output, uniqueTargetThreads: allThreads.size, datasets: summaries.map(({ dataset, executions, overall, perRepeat, scoreChangedCases, officialInstructionMetrics }) => ({ dataset, executions, overall, perRepeat, scoreChangedCases, officialInstructionMetrics })) }));
