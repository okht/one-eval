import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareGrading, preparePlan } from '../../src/config.ts';
import { calibrateGrading } from '../../src/preflight.ts';
import { runEvaluation, resumeEvaluation } from '../../src/execution.ts';
import { gradeEvaluation } from '../../src/grading.ts';
import { buildReport } from '../../src/report.ts';
import { listArtifacts, latestArtifacts } from '../../src/storage.ts';

const [phase, input, destination, resultPath] = process.argv.slice(2);
if (!['grading', 'native', 'simulated', 'retry-native', 'retry-simulated'].includes(phase)) throw new Error('Unknown acceptance phase');
const data = path.resolve(input), directory = path.resolve(destination), output = path.resolve(resultPath);
await mkdir(path.dirname(output), { recursive: true });
const sourceNames = ['config', 'types', 'grading', 'execution', 'adapters', 'preflight', 'report'];
const coreSources = await Promise.all(sourceNames.map(async name => ({ file: `src/${name}.ts`, sha256: createHash('sha256').update(await readFile(new URL(`../../src/${name}.ts`, import.meta.url))).digest('hex') })));
await writeFile(`${output}.start.json`, `${JSON.stringify({ phase, startedAt: new Date().toISOString(), coreSources }, null, 2)}\n`, { flag: 'wx' });
let result;
if (phase === 'grading') result = await calibrateGrading(await prepareGrading(path.join(data, 'judges.json')), path.join(data, 'calibration.json'), directory);
else {
  const name = phase.replace('retry-', '');
  let execution;
  if (phase.startsWith('retry-')) {
    const errors = latestArtifacts(await listArtifacts(directory)).filter(item => item.status === 'execution_error');
    if (!errors.length || errors.some(item => item.attempt !== 1)) throw new Error('Explicit acceptance retry requires first-attempt execution errors only');
    execution = await resumeEvaluation(directory, { retryErrors: true });
  } else execution = await runEvaluation(await preparePlan(path.join(data, `${name}-eval.json`)), directory);
  const prepared = await prepareGrading(path.join(data, 'native-judges.json'));
  const grading = await gradeEvaluation(directory, prepared);
  const report = await buildReport(directory, prepared.versionHash);
  result = { execution, grading, report };
}
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(phase === 'grading' ? { ok: result.ok, planned: result.planned, matched: result.matched, mismatched: result.mismatched, errors: result.errors, missing: result.missing, gradingVersion: result.gradingVersion } : { execution: result.execution, complete: result.report.complete, overall: result.report.overall }));
process.exitCode = phase === 'grading' ? result.ok ? 0 : 1 : result.report.complete ? 0 : 1;
