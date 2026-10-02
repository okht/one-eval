import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [dataInput, evidenceInput, gradingInput, nativeInput, simulatedInput] = process.argv.slice(2);
const data = path.resolve(dataInput), evidence = path.resolve(evidenceInput);
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const optional = async file => { try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
const gold = await read(path.join(data, 'gold.json'));
const grading = await read(path.join(evidence, 'grading.json'));
const calls = await Promise.all((await readdir(path.join(evidence, 'calls'))).filter(name => name.endsWith('.result.json')).map(name => read(path.join(evidence, 'calls', name))));
const starts = (await readdir(path.join(evidence, 'calls'))).filter(name => name.endsWith('.start.json')).length;
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); };
const gradingDirectory = path.resolve(gradingInput);
let verifiedGradeRecords = 0, rawGradeMatches = 0;
for (const result of grading.results) {
  if (!result.recordId) continue;
  const record = await read(path.join(gradingDirectory, 'grades', grading.gradingVersion, 'records', `${result.recordId}.json`));
  if (record.caseId === result.fixtureId && record.judgeId === result.judgeId && record.repeat === result.repeat && record.status === result.actual?.status && record.score === result.actual?.score && record.reason === result.actual?.reason) verifiedGradeRecords++;
  try {
    const raw = typeof record.rawOutput === 'string' ? JSON.parse(record.rawOutput) : record.rawOutput;
    if (raw?.status === record.status && raw?.score === record.score && raw?.reason === record.reason) rawGradeMatches++;
  } catch { /* The check below reports retained malformed output without hiding it. */ }
}
check('calibration_matches_saved_grade_records', verifiedGradeRecords === grading.planned, { verified: verifiedGradeRecords, expected: grading.planned });
check('saved_scores_match_raw_model_output', rawGradeMatches === grading.planned - grading.errors - grading.missing, { verified: rawGradeMatches, expected: grading.planned - grading.errors - grading.missing });
check('hard_call_limit', starts <= 180, { started: starts, maximum: 180 });
check('all_calls_terminal', starts === calls.length, { started: starts, terminal: calls.length });
const typed = calls.map(call => {
  if (!call.ephemeral) return { ...call, purpose: 'target' };
  let input;
  try { input = JSON.parse(call.prompt.slice(call.prompt.lastIndexOf('\n\nUSER\n') + 7)); } catch { return { ...call, purpose: 'unknown' }; }
  return { ...call, purpose: input.case ? 'judge' : input.scenario ? 'simulator' : 'unknown', parsedInput: input };
});
const judgeCalls = typed.filter(call => call.purpose === 'judge');
check('exactly_one_call_per_judge_slot', judgeCalls.length === 96 && new Set(judgeCalls.map(call => `${call.parsedInput.case.id}:${call.parsedInput.judgeId}:${call.parsedInput.repeat}`)).size === 96, { calls: judgeCalls.length });
check('gold_labels_withheld', judgeCalls.every(call => call.parsedInput.expected === undefined && call.parsedInput.label === undefined && call.parsedInput.case.expected === undefined && call.parsedInput.case.label === undefined), 'Scoring references remain present; calibration labels and expected score bands are absent');
const completedJudges = judgeCalls.filter(call => call.status === 'completed');
check('fresh_judge_threads', new Set(completedJudges.map(call => call.threadId)).size === completedJudges.length && judgeCalls.every(call => call.expectedThreadId === null), { completed: completedJudges.length, unique: new Set(completedJudges.map(call => call.threadId)).size });
const freshCalls = calls.filter(call => call.status === 'completed' && call.expectedThreadId === null);
const freshThreads = new Set(freshCalls.map(call => call.threadId));
check('fresh_threads_unique_across_all_phases', freshThreads.size === freshCalls.length && calls.filter(call => call.status === 'completed' && call.expectedThreadId !== null).every(call => call.threadId === call.expectedThreadId && freshThreads.has(call.threadId)), { freshCalls: freshCalls.length, distinctFreshThreads: freshThreads.size, resumedCalls: calls.filter(call => call.expectedThreadId !== null).length });
const mismatch = grading.results.filter(item => item.status !== 'matched').map(item => ({ ...item, category: gold.find(row => row.id === item.fixtureId)?.category, rationale: gold.find(row => row.id === item.fixtureId)?.rationale }));
const agreement = new Map();
for (const item of grading.results) {
  const key = `${item.fixtureId}:${item.repeat}`;
  if (!agreement.has(key)) agreement.set(key, []);
  agreement.get(key).push(item.actual ? { status: item.actual.status, score: item.actual.score ?? null } : null);
}
const gradingSummary = { ok: grading.ok, planned: grading.planned, matched: grading.matched, mismatched: grading.mismatched, errors: grading.errors, missing: grading.missing, gradingVersion: grading.gradingVersion,
  actualStatuses: Object.fromEntries(['scored', 'abstained', 'insufficient_evidence', 'grading_error'].map(status => [status, grading.results.filter(item => item.actual?.status === status).length])),
  byModel: Object.fromEntries([...new Set(grading.results.map(item => item.judgeId))].map(model => { const rows = grading.results.filter(item => item.judgeId === model); return [model, { total: rows.length, matched: rows.filter(item => item.status === 'matched').length, mismatched: rows.filter(item => item.status === 'mismatched').length, errors: rows.filter(item => item.status === 'grading_error').length }]; })),
  crossModelAgreement: { compared: agreement.size, agreed: [...agreement.values()].filter(values => values.length === 2 && values[0] !== null && JSON.stringify(values[0]) === JSON.stringify(values[1])).length }, nonMatches: mismatch };

async function summarizeExecution(name, directory, expectedTrials) {
  directory = path.resolve(directory);
  const result = await optional(path.join(evidence, `${name}-retry.json`)) ?? await read(path.join(evidence, `${name}.json`));
  const artifacts = await Promise.all((await readdir(path.join(directory, 'artifacts'))).filter(file => file.endsWith('.json')).map(file => read(path.join(directory, 'artifacts', file))));
  const latest = new Map(); for (const artifact of artifacts) if (!latest.has(artifact.trialId) || latest.get(artifact.trialId).attempt < artifact.attempt) latest.set(artifact.trialId, artifact);
  const final = [...latest.values()];
  const completed = final.filter(item => item.status === 'completed');
  const audit = (await readFile(path.join(evidence, `${name}-audit.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const created = audit.filter(event => event.type === 'session.created'), deleted = audit.filter(event => event.type === 'session.deleted');
  const firstCreated = Math.min(...created.map(event => Date.parse(event.at)));
  const lastClosed = Math.max(...audit.filter(event => event.type === 'service.closed').map(event => Date.parse(event.at)));
  const phaseCalls = calls.filter(call => !call.ephemeral && Date.parse(call.startedAt) >= firstCreated && Date.parse(call.finishedAt) <= lastClosed);
  const timeline = phaseCalls.flatMap(call => [{ at: Date.parse(call.startedAt), delta: 1 }, { at: Date.parse(call.finishedAt), delta: -1 }]).sort((a, b) => a.at - b.at || a.delta - b.delta);
  let overlap = 0, maximumConcurrentNativeCalls = 0;
  for (const event of timeline) { overlap += event.delta; maximumConcurrentNativeCalls = Math.max(maximumConcurrentNativeCalls, overlap); }
  if (name === 'native') check('three_real_native_invocations_overlap', maximumConcurrentNativeCalls >= 3, { maximumConcurrentNativeCalls });
  const active = new Set(); let maximumActive = 0;
  for (const event of audit) { if (event.type === 'session.created') active.add(event.sessionId); if (event.type === 'session.deleted') active.delete(event.sessionId); maximumActive = Math.max(maximumActive, active.size); }
  let absent = 0; for (const session of created) { try { await access(session.directory); } catch (error) { if (error.code === 'ENOENT') absent++; else throw error; } }
  check(`${name}_cleaned_sessions`, deleted.length === created.length && absent === created.length && active.size === 0 && audit.some(item => item.type === 'service.closed' && item.activeSessions === 0), { created: created.length, deleted: deleted.length, absentDirectories: absent, active: active.size });
  const finalCalls = completed.flatMap(item => item.metadata?.target?.calls ?? []);
  const finalTokens = completed.map(item => item.metadata?.target?.calls?.[0]?.metadata?.canary);
  const finalThreads = completed.map(item => item.metadata?.target?.calls?.[0]?.metadata?.nativeThreadId);
  check(`${name}_unique_final_canaries_and_threads`, new Set(finalTokens).size === completed.length && new Set(finalThreads).size === completed.length && finalTokens.every(Boolean) && finalThreads.every(Boolean), { completedTrials: completed.length, uniqueCanaries: new Set(finalTokens).size, uniqueThreads: new Set(finalThreads).size });
  const leaks = [];
  for (const artifact of completed) {
    const own = artifact.metadata.target.calls[0].metadata.canary;
    const tokens = artifact.messages.filter(message => message.role === 'assistant').flatMap(message => message.content.match(/CANARY_[a-f0-9]{20}(?:_UPDATED)?/g) ?? []);
    for (const token of tokens) if (token !== own && token !== `${own}_UPDATED`) leaks.push({ trialId: artifact.trialId, caseId: artifact.caseId, token, own });
  }
  check(`${name}_no_foreign_canaries`, leaks.length === 0, { observedLeaks: leaks });
  let rawTransportVerified = 0;
  for (const call of finalCalls) {
    const raw = calls.find(item => item.callId === call.metadata.callId);
    if (raw && raw.threadId === call.metadata.nativeThreadId && (call.metadata.nativeResume ? raw.expectedThreadId === raw.threadId && raw.prompt === call.metadata.transportInput : raw.expectedThreadId === null && raw.prompt.endsWith(call.metadata.transportInput))) rawTransportVerified++;
  }
  check(`${name}_native_transport_evidence`, rawTransportVerified === finalCalls.length, { finalCalls: finalCalls.length, verified: rawTransportVerified });
  const simulatorCalls = completed.flatMap(item => item.metadata?.simulator?.calls ?? []);
  if (name === 'simulated') check('fresh_real_simulator_calls', simulatorCalls.every(call => typed.some(raw => raw.purpose === 'simulator' && raw.callId === call.metadata?.callId && raw.status === 'completed')) && new Set(simulatorCalls.map(call => call.metadata?.threadId)).size === simulatorCalls.length, { calls: simulatorCalls.length });
  const reportFailures = result.report.cases.flatMap(item => item.executions.filter(execution => execution.score !== 1).map(execution => ({ caseId: item.caseId, repeat: execution.repeat, status: execution.status, score: execution.score, judges: execution.judges })));
  const judgeReasons = result.report.cases.flatMap(item => item.executions.flatMap(execution => execution.judges.flatMap(judge => judge.grades.map(grade => { try { return JSON.parse(grade.reason); } catch { return undefined; } })))).filter(Boolean);
  const blank = completed.filter(item => ['session-d', 'session-e'].includes(item.caseId));
  return { expectedTrials, recordedTrials: final.length, completedTrials: completed.length, complete: result.report.complete, overall: result.report.overall, firstAttemptErrors: artifacts.filter(item => item.attempt === 1 && item.status !== 'completed').map(item => ({ trialId: item.trialId, caseId: item.caseId, repeat: item.repeat, status: item.status, error: item.error })), attempts: artifacts.length, sessionAttempts: created.length, cleanedSessions: deleted.length, maximumConcurrentAllocatedSessions: maximumActive, maximumConcurrentNativeCalls, finalNativeTurns: finalCalls.length, finalNativeResumeTurns: finalCalls.filter(call => call.metadata.nativeResume).length, uniqueFinalCanaries: new Set(finalTokens).size, uniqueFinalThreads: new Set(finalThreads).size, foreignCanaryLeaks: leaks, blankProbes: blank.length, blankUnknown: blank.filter(item => item.output.trim() === 'UNKNOWN').length, realSimulatorCalls: simulatorCalls.length, simulatorStopCount: completed.filter(item => item.stopReason === 'simulator_stop').length, finalValueCorrect: judgeReasons.filter(item => item.finalValueCorrect).length, reportFailures, gradingVersion: result.report.gradingVersion };
}
const native = await summarizeExecution('native', nativeInput, 15);
const simulated = simulatedInput ? await summarizeExecution('simulated', simulatedInput, 4) : undefined;
const phaseSourceSnapshots = await Promise.all(['grading', 'native', ...(simulated ? ['simulated'] : [])].map(async phase => ({ source: `${phase}.json.start.json`, ...await read(path.join(evidence, `${phase}.json.start.json`)) })));
const acceptancePassed = grading.ok && native.complete && native.overall === 1 && (!simulated || (simulated.complete && simulated.overall === 1)) && checks.every(item => item.ok);
const summary = { generatedAt: new Date().toISOString(), acceptancePassed, hardCallLimit: 180, calls: { started: starts, completed: calls.filter(item => item.status === 'completed').length, failed: calls.filter(item => item.status !== 'completed').length, byPurpose: Object.fromEntries(['judge', 'target', 'simulator', 'unknown'].map(purpose => [purpose, typed.filter(item => item.purpose === purpose).length])), failures: calls.filter(item => item.status !== 'completed').map(item => ({ callId: item.callId, requestedModel: item.requestedModel, error: item.error })) }, grading: gradingSummary, native, ...(simulated ? { simulated } : {}), auditChecksPassed: checks.every(item => item.ok), checks, phaseSourceSnapshots,
  limitations: ['Agent-authored preregistered gold fixtures, not independent human annotations.', 'Two requested models from one provider family, not cross-vendor coverage.', 'Local real-model-backed loopback HTTP, not production API isolation certification.', 'Codex native history retained for audit; service sessions and working directories cleaned.', 'Model score disagreements are retained without relaxing gold expectations or rerunning low scores.'] };
await writeFile(path.join(evidence, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary));
