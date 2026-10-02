import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareGrading } from '../../src/config.ts';
import { resumeEvaluation } from '../../src/execution.ts';
import { gradeEvaluation } from '../../src/grading.ts';
import { buildReport } from '../../src/report.ts';
import { listArtifacts, latestArtifacts } from '../../src/storage.ts';

// This separate command is an explicit operator retry. Normal acceptance runners never retry.
const data = path.resolve(process.argv[2]);
const directory = path.resolve(process.argv[3]);
const resultFile = path.resolve(process.argv[4]);
const previous = latestArtifacts(await listArtifacts(directory));
const failed = previous.filter(item => item.status === 'execution_error');
if (!failed.length || failed.some(item => item.attempt !== 1)) throw new Error('This acceptance command retries first-attempt execution errors once only');
const execution = await resumeEvaluation(directory, { retryErrors: true });
const prepared = await prepareGrading(path.join(data, 'native-judges.json'));
const grading = await gradeEvaluation(directory, prepared);
const report = await buildReport(directory, prepared.versionHash);
await writeFile(resultFile, `${JSON.stringify({ explicitlyRetriedTrials: failed.map(item => item.trialId), execution, grading, report }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ explicitlyRetriedTrials: failed.length, execution, complete: report.complete, overall: report.overall }));
process.exitCode = report.complete ? 0 : 1;
