import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { hash, readManifest, readRunState, listArtifacts, latestArtifacts, readJson, withRunLock, readAttemptLedger, validateExecutionEvidence } from './storage.js';
import { gradeIdentity, latestGradeRecords, readGradeRecords, readGradingState, validateArtifactHash, validateGradingManifest, validateGradeRecordLinks, readGradeReservations } from './grading.js';
import type { GradeManifest } from './grading.js';
import type { GradeRecord, TrialArtifact } from './types.js';
import { analyzeReport, weightedMean } from './report-analysis.js';
import { classifyError } from './diagnostics.js';
import { validateAdmissionRecord } from './admission.js';

function mean(values: number[]): number | null { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function statistics(values: number[]) {
  const average = mean(values);
  return { count: values.length, mean: average, min: values.length ? values.reduce((a,b)=>Math.min(a,b),Infinity) : null, max: values.length ? values.reduce((a,b)=>Math.max(a,b),-Infinity) : null, standardDeviation: average === null ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length) };
}

export async function buildReport(directory: string, gradingVersion?: string) {
  directory = path.resolve(directory);
  return withRunLock(directory, async () => {
    const manifest = await readManifest(directory);
    validateAdmissionRecord(manifest.admission);
    const executionState = await readRunState(directory);
    let versions: string[];
    try { versions = (await readdir(path.join(directory, 'grades'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; versions = []; }
    if (!gradingVersion && versions.length > 1) throw new Error('Multiple grading versions exist; specify gradingVersion explicitly');
    const version = gradingVersion ?? versions[0];
    if (version && (!/^[a-f0-9]+$/i.test(version) || !versions.includes(version))) throw new Error('Unknown grading version');
    const gradeManifest = version ? await readJson<GradeManifest>(path.join(directory, 'grades', version, 'manifest.json')) : undefined;
    const gradingState = version ? await readGradingState(directory, version) : undefined;
    if (gradeManifest) validateGradingManifest(gradeManifest, manifest, version);
    const judges = gradeManifest?.prepared.plan.judges ?? [];
    const allGrades = version ? await readGradeRecords(directory, version) : [];
    const gradeRecords = latestGradeRecords(allGrades);
    const allArtifacts = await listArtifacts(directory);
    const artifacts = latestArtifacts(allArtifacts);
    const problems = validateExecutionEvidence(manifest, allArtifacts, await readAttemptLedger(directory));
    if (gradeManifest) {
      try {
        validateGradeRecordLinks(allGrades, manifest, gradeManifest.prepared, allArtifacts);
        const reservations = await readGradeReservations(directory, version!);
        validateGradeRecordLinks(reservations, manifest, gradeManifest.prepared, allArtifacts);
        const finished = new Map(allGrades.map(record => [record.id, record]));
        for (const reservation of reservations) {
          const record = finished.get(reservation.id);
          if (!record) problems.push(`Started grading attempt has missing evidence: ${reservation.id}`);
          else if (reservation.caseId !== record.caseId || reservation.createdAt !== record.createdAt) problems.push(`Grading record identity differs from its started-attempt reservation: ${record.id}`);
        }
      }
      catch(error) { problems.push(classifyError(error,'report.grading_evidence').message); }
    }
    const slots = new Map<string, TrialArtifact>();
    const repeats = manifest.prepared.plan.execution.repeats;
    const caseIds = new Set(manifest.prepared.plan.cases.map((item) => item.id));
    for (const artifact of artifacts) {
      if (artifact.runId !== manifest.runId || !caseIds.has(artifact.caseId) || !Number.isInteger(artifact.repeat) || artifact.repeat < 0 || artifact.repeat >= repeats) { problems.push(`Unexpected artifact: ${artifact.trialId}`); continue; }
      const key = JSON.stringify([artifact.caseId, artifact.repeat]);
      if (slots.has(key)) { problems.push(`Duplicate execution slot: ${key}`); continue; }
      slots.set(key, artifact);
    }
    let completedExecutions = 0; let failedExecutions = 0; let missingExecutions = 0; let invalidExecutions = 0;
    let scored = 0; let abstained = 0; let insufficientEvidence = 0; let gradingErrors = 0; let missingGrades = 0;
    const cases = manifest.prepared.plan.cases.map((evalCase) => {
      const executions = Array.from({ length: repeats }, (_, repeat) => {
        const artifact = slots.get(JSON.stringify([evalCase.id, repeat]));
        let valid = false;
        if (!artifact) missingExecutions++;
        else if (artifact.status !== 'completed') failedExecutions++;
        else {
          try { validateArtifactHash(artifact); valid = true; completedExecutions++; }
          catch (error) { invalidExecutions++; problems.push(error instanceof Error ? error.message : String(error)); }
        }
        const judgeResults = judges.map((judge) => {
          const values: number[] = [];
          const grades = Array.from({ length: judge.repeats }, (_, gradeRepeat) => {
            const record = valid && artifact && version ? gradeRecords.get(gradeIdentity({ trialId: artifact.trialId, executionAttempt: artifact.attempt, outputHash: artifact.outputHash!, gradingVersion: version, judgeId: judge.id, repeat: gradeRepeat })) : undefined;
            if (!record) { missingGrades++; return { repeat: gradeRepeat, status: 'missing' as const }; }
            if (record.runId !== manifest.runId || record.caseId !== evalCase.id) throw new Error('Grading record identity does not match the execution artifact');
            if (record.status === 'scored') { scored++; values.push(record.score!); }
            else if (record.status === 'abstained') abstained++;
            else if (record.status === 'insufficient_evidence') insufficientEvidence++;
            else gradingErrors++;
            return { repeat: gradeRepeat, attempt: record.attempt, status: record.status, score: record.score, reason: record.reason,
              diagnostic:record.diagnostic,cleanupDiagnostic:record.cleanupDiagnostic,durationMs:record.durationMs,usage:record.usage };
          });
          const complete = values.length === judge.repeats;
          return { judgeId: judge.id, weight: judge.weight, expected: judge.repeats, complete, score: complete ? mean(values) : null, observed: statistics(values), grades };
        });
        const complete = valid && judgeResults.length > 0 && judgeResults.every((judge) => judge.complete);
        const score = complete ? weightedMean(judgeResults.map(judge=>({score:judge.score!,weight:judge.weight}))) : null;
        return { repeat, trialId: artifact?.trialId, executionAttempt: artifact?.attempt, status: !artifact ? 'missing' : valid ? 'completed' : artifact.status === 'completed' ? 'invalid_artifact' : artifact.status,
          diagnostic:artifact?.diagnostic,cleanupDiagnostic:artifact?.cleanupDiagnostic,complete, score, judges: judgeResults };
      });
      const values = executions.flatMap((execution) => execution.score === null ? [] : [execution.score]);
      const complete = executions.every((execution) => execution.complete);
      return { caseId: evalCase.id, inputHash:hash({input:evalCase.input,reference:evalCase.reference,conversation:evalCase.conversation,metadata:evalCase.metadata}),
        metadata:evalCase.metadata,weight: evalCase.weight, expected: repeats, complete, score: complete ? mean(values) : null, observed: statistics(values), executions };
    });
    const blocked = executionState.blocked || gradingState?.blocked === true;
    const complete = !blocked && cases.length > 0 && cases.every((item) => item.complete) && problems.length === 0;
    const overall = complete ? weightedMean(cases.map(item=>({score:item.score!,weight:item.weight}))) : null;
    return {
      version: 1, runId: manifest.runId, gradingVersion: version ?? null, complete, overall, blocked,
      admission: { execution: manifest.admission?.mode ?? 'legacy_unverified', grading: gradeManifest ? gradeManifest.admission?.mode ?? 'legacy_unverified' : 'not_graded' },
      runtime: { execution: manifest.runtime ?? null, grading: gradeManifest?.runtime ?? null },
      executionState, gradingState,
      executionCoverage: { expected: cases.length * repeats, completed: completedExecutions, failed: failedExecutions, missing: missingExecutions, invalid: invalidExecutions },
      gradeCoverage: { expected: cases.length * repeats * judges.reduce((sum, judge) => sum + judge.repeats, 0), scored, abstained, insufficientEvidence, errors: gradingErrors, missing: missingGrades },
      observed: { completedCaseScores: statistics(cases.flatMap((item) => item.score === null ? [] : [item.score])), note: 'Observed statistics exclude unavailable values; they are not a reweighted overall score.' },
      analysis:analyzeReport(cases,allArtifacts,allGrades,cases.length*repeats,blocked||problems.length>0),
      problems, cases,
    };
  });
}
