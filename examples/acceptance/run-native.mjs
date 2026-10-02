import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareGrading, preparePlan } from '../../src/config.ts';
import { runEvaluation } from '../../src/execution.ts';
import { gradeEvaluation } from '../../src/grading.ts';
import { buildReport } from '../../src/report.ts';

const data = path.resolve(process.argv[2]);
const directory = path.resolve(process.argv[3]);
const resultFile = path.resolve(process.argv[4]);
const execution = await runEvaluation(await preparePlan(path.join(data, 'native-eval.json')), directory);
console.error(JSON.stringify({ phase: 'native_execution', ...execution }));
const prepared = await prepareGrading(path.join(data, 'native-judges.json'));
const grading = await gradeEvaluation(directory, prepared);
const report = await buildReport(directory, prepared.versionHash);
await mkdir(path.dirname(resultFile), { recursive: true });
await writeFile(resultFile, `${JSON.stringify({ execution, grading, report }, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ execution, grading, complete: report.complete, overall: report.overall }));
process.exitCode = report.complete ? 0 : 1;
