// Install a clean source plugin with the real Codex plugin manager, without model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(path.join(await realpath(tmpdir()), 'one-eval-plugin-install-'));
const source = path.join(temporary, 'clean plugin source');
const profile = path.join(temporary, 'codex-profile');
const workspace = path.join(temporary, 'evaluation workspace');
const cache = path.join(temporary, 'runtime-cache');
const evidence = path.join(root, 'results', `plugin-installation-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`);
for (const directory of [source, profile, workspace, evidence]) await mkdir(directory, { recursive: true });
const environment = { ...process.env, CODEX_HOME: profile, ONE_EVAL_PLUGIN_CACHE_DIR: cache, PROMPTFOO_DISABLE_TELEMETRY: '1', PROMPTFOO_DISABLE_UPDATE: '1' };
const entries = ['.agents/plugins/marketplace.json', '.codex-plugin/plugin.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'src', 'templates', 'skills', 'docs', 'README.md', 'THIRD_PARTY_NOTICES.md', 'scripts/codex-plugin.mjs'];
for (const entry of entries) {
  await mkdir(path.dirname(path.join(source, entry)), { recursive: true });
  await cp(path.join(root, entry), path.join(source, entry), { recursive: true, errorOnExist: true, force: false });
}
const commands = [];
async function execute(label, executable, args, expectedCode = 0, extraEnv = {}) {
  process.stderr.write(`[plugin] ${label}\n`);
  const startedAt = new Date().toISOString();
  const child = spawn(executable, args, { cwd: workspace, env: { ...environment, ...extraEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => {
    stderr += value;
    if (label === 'explicit clean runtime setup') process.stderr.write(value);
  });
  const timer = setTimeout(() => child.kill(), 600_000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); }
  commands.push({ label, executable, args, startedAt, finishedAt: new Date().toISOString(), code, stdout, stderr });
  await writeFile(path.join(evidence, 'commands.json'), JSON.stringify(commands, null, 2) + '\n');
  assert.equal(code, expectedCode, `${label}: ${stderr || stdout}`);
  return stdout;
}
async function codexInvocation() {
  const configured = process.env.ONE_EVAL_TEST_CODEX_BIN || process.env.CODEX_CLI_PATH;
  if (configured) {
    await access(configured);
    return /\.[cm]?js$/i.test(configured) ? { command: process.execPath, prefix: [configured] } : { command: configured, prefix: [] };
  }
  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      const entry = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      try { await access(entry); return { command: process.execPath, prefix: [entry] }; } catch {}
    }
    return { command: 'codex.exe', prefix: [] };
  }
  return { command: 'codex', prefix: [] };
}
async function manifestDirectories(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(directory, entry.name);
    if (entry.name === '.codex-plugin') {
      const manifest = JSON.parse(await readFile(path.join(candidate, 'plugin.json'), 'utf8'));
      if (manifest.name === 'one-eval') found.push(directory);
    } else found.push(...await manifestDirectories(candidate));
  }
  return found;
}
try {
  const invocation = await codexInvocation();
  const codex = (label, args) => execute(label, invocation.command, [...invocation.prefix, ...args]);
  const codexVersion = (await codex('Codex version', ['--version'])).trim();
  const market = JSON.parse(await codex('register isolated local marketplace', ['plugin', 'marketplace', 'add', source, '--json']));
  const installed = JSON.parse(await codex('install source plugin', ['plugin', 'add', 'one-eval@one-eval-plugins', '--json']));
  const listing = JSON.parse(await codex('verify plugin listing', ['plugin', 'list', '--marketplace', 'one-eval-plugins', '--json']));
  const matches = await manifestDirectories(path.join(profile, 'plugins', 'cache'));
  assert.equal(matches.length, 1, 'Expected exactly one installed one-eval plugin');
  const plugin = matches[0];
  assert.ok(plugin.startsWith(profile + path.sep));
  assert.equal(installed.pluginId, 'one-eval@one-eval-plugins');
  assert.equal(await realpath(installed.installedPath), await realpath(plugin));
  const listed = listing.installed.filter(entry => entry.pluginId === installed.pluginId);
  assert.equal(listed.length, 1, 'Expected exactly one installed plugin listing');
  assert.equal(listed[0].installed, true);
  assert.equal(listed[0].enabled, true);
  for (const file of ['skills/evaluate/SKILL.md', 'scripts/codex-plugin.mjs', 'src/cli.ts', 'templates/offline/target.mjs', 'package-lock.json']) await access(path.join(plugin, file));
  for (const name of ['.env', 'data', 'results', 'runs', 'node_modules', 'dist', '.git']) await assert.rejects(access(path.join(plugin, name)), { code: 'ENOENT' });
  if (process.argv.includes('--install-only')) {
    const summary = { installationPassed: true, fullWorkflowTested: false, codexVersion, plugin, profile, market, installed, listing, modelCalls: 0 };
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ installationPassed: true, evidence, plugin, codexVersion }));
  } else {
    const bridge = path.join(plugin, 'scripts', 'codex-plugin.mjs');
    const call = async (label, args, expectedCode = 0) => JSON.parse(await execute(label, process.execPath, [bridge, ...args], expectedCode));
    const before = await call('doctor before setup', ['doctor'], 1);
    assert.equal(before.runtime.ready, false);
    const setup = await call('explicit clean runtime setup', ['setup']);
    assert.equal(setup.ok, true); assert.equal(setup.alreadyReady, false);
    const again = await call('idempotent runtime setup', ['setup']);
    assert.equal(again.alreadyReady, true); assert.equal(again.runtime.key, setup.runtime.key);
    const doctor = await call('doctor after setup', ['doctor']);
    assert.equal(doctor.ok, true); assert.equal(doctor.runtime.ready, true);
    const schema = await call('schema through installed bridge', ['schema']);
    assert.ok(schema.execution && schema.grading && schema.calibration && schema.admission);
    const version = await call('runtime identity', ['version']);
    const starter = await call('generate offline evaluation in caller workspace', ['init', 'evaluation', '--template', 'offline']);
    assert.equal(starter.directory, path.join(workspace, 'evaluation'));
    await execute('formal execution refuses missing probe', process.execPath, [bridge, 'run', 'evaluation/eval.json', '--out', 'blocked-run'], 1);
    const probe = await call('execution preflight', ['probe', 'evaluation/eval.json', '--out', 'probe']);
    assert.equal(probe.ok, true); assert.ok(probe.receiptPath);
    const run = await call('formal execution', ['run', 'evaluation/eval.json', '--out', 'evaluation-run', '--preflight', probe.receiptPath]);
    assert.equal(run.completed, 4); assert.equal(run.mode, 'formal');
    // A separate CLI process must grade stored answers even if the target cannot load.
    const target = path.join(workspace, 'evaluation', 'target.mjs');
    const targetSource = await readFile(target, 'utf8');
    await writeFile(target, "throw new Error('Target must not load while grading saved answers');\n");
    const calibration = await call('independent grading calibration', ['calibrate', 'evaluation/calibration.json', '--config', 'evaluation/judges.json', '--out', 'calibration']);
    assert.equal(calibration.ok, true); assert.equal(calibration.matched, 4);
    const grading = await call('formal grading of saved answers', ['grade', 'evaluation-run', '--config', 'evaluation/judges.json', '--calibration', calibration.receiptPath]);
    assert.equal(grading.mode, 'formal');
    const report = await call('saved report', ['report', 'evaluation-run']);
    assert.equal(report.complete, true); assert.equal(report.overall, 1);
    assert.deepEqual(report.admission, { execution: 'formal', grading: 'formal' });
    assert.equal(report.executionCoverage.completed, 4); assert.equal(report.gradeCoverage.scored, 4);
    assert.equal(report.runtime.execution.implementationHash, version.implementationHash);
    assert.equal(report.runtime.grading.implementationHash, version.implementationHash);
    await writeFile(target, targetSource);
    const resumed = await call('resume completed formal execution', ['resume', 'evaluation-run']);
    assert.equal(resumed.completed, 4); assert.equal(resumed.pending, 0);
    const regraded = await call('reuse completed grades', ['grade', 'evaluation-run', '--config', 'evaluation/judges.json']);
    assert.equal(regraded.recorded, grading.recorded);
    const summary = { passed: true, codexVersion, plugin, profile, workspace, cache, source, market, installed, listing,
      doctor, runtime: version, setup, run, calibration: { matched: calibration.matched, planned: calibration.planned }, grading, report,
      sourcePackageInstalled: true, callerWorkspacePreserved: true, targetDisabledDuringGrading: true, modelCalls: 0,
      retainedTemporaryEvidence: temporary, generatedAt: new Date().toISOString() };
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ passed: true, evidence, codexVersion, execution: run.completed, graded: report.gradeCoverage.scored, modelCalls: 0 }));
  }
} catch (error) {
  await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ passed: false, message: error.message, temporary, at: new Date().toISOString() }, null, 2) + '\n');
  throw error;
}
