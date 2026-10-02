// Install the real npm tarball in an empty consumer directory and exercise its CLI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
await access(npm);
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(path.join(temporaryRoot, 'one-eval-package-'));
const consumer = path.join(temporary, 'consumer');
const evidence = path.join(root, 'results', `distribution-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
await mkdir(consumer);
await mkdir(evidence, { recursive: true });
const transcript = [];
const env = { ...process.env, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' };
delete env.ONE_EVAL_EXAMPLE_TARGET_DISABLED;

async function execute(label, executable, args, cwd = consumer, extraEnv = {}) {
  console.error(`[package] ${label}`);
  const startedAt = new Date().toISOString();
  const child = spawn(executable, args, { cwd, env: { ...env, ...extraEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { stderr += value; });
  const timer = setTimeout(() => child.kill(), 300_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  transcript.push({ label, executable, args, cwd, startedAt, finishedAt: new Date().toISOString(), code, stdout, stderr });
  await writeFile(path.join(evidence, 'commands.json'), JSON.stringify(transcript, null, 2) + '\n');
  if (code !== 0) throw new Error(`${label} exited ${code}: ${stderr || stdout}`);
  return stdout;
}
const npmCommand = (label, args, cwd = consumer) => execute(label, process.execPath, [npm, ...args], cwd);
const cli = async (label, args, extraEnv = {}) => JSON.parse(await execute(label, process.execPath, [npm, 'exec', '--offline', '--', 'one-eval', ...args], consumer, extraEnv));
let passed = false;
try {
  const [packed] = JSON.parse(await npmCommand('pack with prepack build', ['pack', '--json', '--pack-destination', temporary], root));
  assert.equal(packed.name, 'one-eval');
  const files = packed.files.map(item => item.path);
  for (const required of ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'dist/cli.js', 'dist/index.js', 'dist/index.d.ts', 'templates/offline/target.mjs', 'templates/managed/target.mjs', 'templates/common/grade.mjs', 'examples/offline/eval.json', 'examples/offline/calibration.json', 'docs/distribution.md', 'docs/admission.md', 'docs/integrations.md']) assert.ok(files.includes(required), `Missing package file: ${required}`);
  for (const file of files) {
    assert.ok(!/^(?:src|tests|scripts|data|runs|results|node_modules|\.github)\//.test(file), `Unexpected package file: ${file}`);
    assert.ok(!/\.map$/.test(file), `Source map should not reference excluded sources: ${file}`);
    assert.ok(!file.startsWith('examples/acceptance') && !file.startsWith('examples/benchmarks/'), `Historical evidence or benchmark source leaked into package: ${file}`);
    assert.ok(!/^docs\/(?:acceptance|benchmark|hardening|regression)/.test(file), `Repository-only report leaked into package: ${file}`);
  }
  const tarball = path.join(temporary, packed.filename);
  await copyFile(tarball, path.join(evidence, packed.filename));
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'one-eval-install-smoke', version: '1.0.0', private: true, type: 'module' }) + '\n');
  await npmCommand('install tarball in empty consumer', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball]);
  const installed = path.join(consumer, 'node_modules/one-eval');
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  assert.equal(await realpath(installed), installed);
  const metadata = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.private, true); assert.equal(metadata.license, 'UNLICENSED');
  assert.equal(metadata.bin['one-eval'], 'dist/cli.js');
  assert.equal(metadata.types, './dist/index.d.ts'); assert.equal(metadata.exports['.'].types, metadata.types);
  const schema = await cli('installed bin schema', ['schema']);
  assert.ok(schema.execution && schema.grading && schema.calibration && schema.admission);
  const version = await cli('installed bin version', ['version']);
  assert.equal(version.oneEvalVersion, metadata.version); assert.match(version.implementationHash, /^[a-f0-9]{64}$/);
  for (const [name, value] of Object.entries(metadata.dependencies)) assert.equal(version.dependencies[name], value);
  await writeFile(path.join(consumer, 'consumer-check.mts'), "import { preparePlan, runEvaluation, buildReport, getRuntimeProvenance } from 'one-eval';\nvoid [preparePlan, runEvaluation, buildReport];\nconst value = await getRuntimeProvenance();\nif (value.oneEvalVersion !== '0.1.0') throw new Error('Unexpected installed version');\n");
  await execute('installed ESM exports', process.execPath, ['--experimental-strip-types', 'consumer-check.mts']);
  await execute('installed TypeScript declaration resolution', process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2023', 'consumer-check.mts']);
  const starter = await cli('installed template assets', ['init', path.join(consumer, 'starter'), '--template', 'offline']);
  assert.equal(starter.template, 'offline'); assert.ok(starter.files.includes('eval.json'));
  const example = path.join(installed, 'examples/offline');
  const config = path.join(example, 'eval.json'); const judges = path.join(example, 'judges.json');
  const runDirectory = path.join(consumer, 'run');
  const probe = await cli('formal execution probe', ['probe', config, '--out', path.join(consumer, 'probe'), '--cases', '2']);
  assert.equal(probe.ok, true); assert.ok(probe.receiptPath);
  const run = await cli('formal execution with receipt', ['run', config, '--out', runDirectory, '--preflight', probe.receiptPath]);
  assert.equal(run.completed, 6); assert.equal(run.failed, 0); assert.equal(run.pending, 0);
  const gradingOnlyEnv = { ONE_EVAL_EXAMPLE_TARGET_DISABLED: '1' };
  const calibration = await cli('independent formal grading calibration', ['calibrate', path.join(example, 'calibration.json'), '--config', judges, '--out', path.join(consumer, 'calibration')], gradingOnlyEnv);
  assert.equal(calibration.ok, true); assert.equal(calibration.matched, 24); assert.ok(calibration.receiptPath);
  const grade = await cli('saved-answer formal grading with receipt', ['grade', runDirectory, '--config', judges, '--calibration', calibration.receiptPath], gradingOnlyEnv);
  const report = await cli('installed saved-answer report', ['report', runDirectory, '--grading-version', grade.gradingVersion], gradingOnlyEnv);
  assert.equal(report.complete, true); assert.equal(report.overall, 1);
  assert.deepEqual(report.admission, { execution: 'formal', grading: 'formal' });
  assert.equal(report.executionCoverage.completed, 6); assert.equal(report.gradeCoverage.scored, 36);
  assert.equal(report.runtime.execution.implementationHash, version.implementationHash);
  assert.equal(report.runtime.grading.implementationHash, version.implementationHash);
  for (const name of ['probe', 'run', 'calibration', 'starter']) await cp(path.join(consumer, name), path.join(evidence, name), { recursive: true, errorOnExist: true, force: false });
  const summary = {
    version: 1, passed: true, platform: process.platform, arch: process.arch, node: process.version,
    npm: (await npmCommand('npm version', ['--version'])).trim(),
    package: { ...packed, sha256: createHash('sha256').update(await readFile(tarball)).digest('hex') },
    runtime: version, cleanConsumer: true, installedBinShim: true, esmExports: true, typesResolved: true,
    templateAssets: true, executionAdmission: report.admission.execution, gradingAdmission: report.admission.grading,
    probe, calibration: { ok: calibration.ok, planned: calibration.planned, matched: calibration.matched, receiptPath: calibration.receiptPath },
    run, grade, report, gradingTargetImportDisabled: true, modelCalls: 0,
    retainedEvidence: ['commands.json', 'probe/', 'run/', 'calibration/', 'starter/', packed.filename],
    remoteCiExecuted: false, publishExecuted: false, generatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  passed = true;
  console.log(JSON.stringify({ passed, evidence, completed: run.completed, scored: report.gradeCoverage.scored, overall: report.overall, modelCalls: 0 }));
} catch (error) {
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ passed: false, message: error.message, temporary, generatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.error(`Package smoke failed; evidence: ${evidence}; retained consumer: ${temporary}`);
  throw error;
} finally {
  if (passed) {
    const stat = await lstat(temporary);
    if (path.dirname(temporary) !== temporaryRoot || !path.basename(temporary).startsWith('one-eval-package-') || stat.isSymbolicLink() || await realpath(temporary) !== temporary) throw new Error('Refusing cleanup outside the owned temporary directory');
    await rm(temporary, { recursive: true, force: false });
  }
}
