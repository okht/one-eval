import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
interface Result { code: number | null; stdout: string; stderr: string }
interface Fixture { directory: string; plugin: string; cache: string; cwd: string; npm: string; log: string }

// npm_execpath is the bridge's normal npm resolution input. Each isolated fixture
// supplies an executable fake npm to test orchestration without network installs.
const fakeNpm = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
if (process.argv[2] === '--version') { console.log('11.6.2'); process.exit(0); }
if (process.env.FAKE_NPM_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_NPM_DELAY_MS)));
if (process.env.FAKE_NPM_FAIL) { console.error('fixture install failure'); process.exit(17); }
mkdirSync('node_modules/typescript/bin', { recursive: true });
mkdirSync('node_modules/example', { recursive: true });
writeFileSync('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.9.3' }));
writeFileSync('node_modules/example/package.json', JSON.stringify({ name: 'example', version: '1.0.0' }));
writeFileSync('node_modules/typescript/bin/tsc', ${JSON.stringify(`if (process.env.FAKE_COMPILER_FAIL) process.exit(19); const fs = require('node:fs'); fs.mkdirSync('dist'); fs.copyFileSync('src/cli.ts', 'dist/cli.js');`)});
console.log('fixture install complete');
`;

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval plugin-runtime-'));
  const plugin = path.join(directory, 'plugin source');
  const cache = path.join(directory, 'cache');
  const cwd = path.join(directory, 'caller work');
  for (const relative of ['scripts', 'src', 'templates/offline', 'results', 'data']) await mkdir(path.join(plugin, relative), { recursive: true });
  await mkdir(cwd);
  await copyFile(path.join(repository, 'scripts', 'codex-plugin.mjs'), path.join(plugin, 'scripts', 'codex-plugin.mjs'));
  await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'one-eval', version: '0.1.0', type: 'module', dependencies: { example: '1.0.0' }, devDependencies: { typescript: '5.9.3' } }));
  await writeFile(path.join(plugin, 'package-lock.json'), JSON.stringify({ name: 'one-eval', lockfileVersion: 3 }));
  await writeFile(path.join(plugin, 'tsconfig.json'), '{}');
  await writeFile(path.join(plugin, 'src', 'cli.ts'), `console.log(JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2)})); if (process.argv[2] === 'failure') { console.error('fixture CLI error'); process.exitCode=23; }`);
  await writeFile(path.join(plugin, 'templates/offline/target.mjs'), 'export const marker = 1;');
  await writeFile(path.join(plugin, '.env'), 'SECRET=never-copy');
  await writeFile(path.join(plugin, 'results', 'private.json'), '{"private":true}');
  await writeFile(path.join(plugin, 'data', 'private.json'), '{"private":true}');
  const npm = path.join(directory, 'fake npm.mjs');
  const log = path.join(directory, 'npm-calls.jsonl');
  await writeFile(npm, fakeNpm);
  return { directory, plugin, cache, cwd, npm, log };
}

function invoke(f: Fixture, args: string[], environment: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.plugin, 'scripts', 'codex-plugin.mjs'), ...args], { cwd: f.cwd, env: { ...process.env, npm_execpath: f.npm, FAKE_NPM_LOG: f.log, ONE_EVAL_PLUGIN_CACHE_DIR: f.cache, ...environment }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

function response(result: Result, expectedCode = 0): any {
  assert.equal(result.code, expectedCode, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function calls(f: Fixture): Promise<Array<{ args: string[]; cwd: string }>> {
  try { return (await readFile(f.log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}

async function waitForLock(f: Fixture): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readdir(f.cache).catch(() => [] as string[])).some(file => file.endsWith('.lock'))) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Fixture setup did not acquire its lock');
}

test('plugin doctor is one JSON response and regular commands never implicitly install', async () => {
  const f = await fixture();
  try {
    const doctor = response(await invoke(f, ['doctor']), 1);
    assert.equal(doctor.node.supported, true);
    assert.equal(doctor.npm.available, true);
    assert.equal(doctor.runtime.ready, false);
    assert.match(doctor.runtime.key, /^[a-f0-9]{64}$/);
    const before = await calls(f);
    const command = await invoke(f, ['schema']);
    assert.equal(command.code, 1);
    assert.equal(command.stdout, '');
    assert.match(JSON.parse(command.stderr).error.message, /setup is required/);
    assert.deepEqual(await calls(f), before);
    assert.deepEqual(await readdir(f.directory), ['caller work', 'fake npm.mjs', 'npm-calls.jsonl', 'plugin source']);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('plugin setup installs only allowlisted inputs and delegates exact arguments, cwd and exit status', async () => {
  const f = await fixture();
  try {
    const setup = response(await invoke(f, ['setup']));
    assert.equal(setup.ok, true);
    assert.equal(setup.alreadyReady, false);
    const runtime = setup.runtime.directory;
    assert.deepEqual((await readdir(runtime)).sort(), ['.one-eval-plugin-runtime.json', 'dist', 'node_modules', 'package-lock.json', 'package.json', 'src', 'templates', 'tsconfig.json']);
    const installs = (await calls(f)).filter(call => call.args[0] === 'ci');
    assert.equal(installs.length, 1);
    assert.deepEqual(installs[0]!.args, ['ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund']);
    assert.ok(installs[0]!.cwd.startsWith(f.cache));
    assert.equal(response(await invoke(f, ['doctor'])).runtime.ready, true);
    const argumentsWithSyntax = ['schema', 'quote" and spaces', '$(touch unexpected)', 'a&b', 'Unicode 中文'];
    const delegated = response(await invoke(f, argumentsWithSyntax));
    assert.deepEqual(delegated, { cwd: f.cwd, argv: argumentsWithSyntax });
    const failed = await invoke(f, ['failure']);
    assert.equal(failed.code, 23);
    assert.equal(failed.stderr.trim(), 'fixture CLI error');
    assert.equal(response(await invoke(f, ['setup'])).alreadyReady, true);
    assert.equal((await calls(f)).filter(call => call.args[0] === 'ci').length, 1);
    assert.equal((await readdir(f.cache)).filter(file => file.startsWith('.')).length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('source, dependency lock and template edits select a new runtime without reusing old builds', async () => {
  const f = await fixture();
  try {
    const first = response(await invoke(f, ['setup'])).runtime;
    for (const [relative, content] of [['src/additional.ts', 'export const extra = 1;'], ['package-lock.json', '{"name":"one-eval","lockfileVersion":3,"changed":true}'], ['templates/offline/target.mjs', 'export const marker = 2;']]) {
      await writeFile(path.join(f.plugin, relative!), content!);
      const doctor = response(await invoke(f, ['doctor']), 1);
      assert.equal(doctor.runtime.ready, false);
      assert.notEqual(doctor.runtime.key, first.key);
      const command = await invoke(f, ['schema']);
      assert.equal(command.code, 1);
    }
    const second = response(await invoke(f, ['setup'])).runtime;
    assert.notEqual(second.directory, first.directory);
    assert.equal((await readdir(f.cache)).length, 2);
    assert.equal(await readFile(path.join(first.directory, 'templates/offline/target.mjs'), 'utf8'), 'export const marker = 1;');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('modified runtime build and metadata are rejected without replacing existing files', async () => {
  const f = await fixture();
  try {
    const runtime = response(await invoke(f, ['setup'])).runtime.directory;
    const cli = path.join(runtime, 'dist', 'cli.js');
    const original = await readFile(cli, 'utf8');
    await writeFile(cli, 'throw new Error("modified runtime must never execute");');
    const invalid = await invoke(f, ['schema']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /changed after setup/);
    const repair = await invoke(f, ['setup']);
    assert.equal(repair.code, 1);
    assert.match(repair.stderr, /move this directory aside/);
    assert.match(await readFile(cli, 'utf8'), /modified runtime/);
    await writeFile(cli, original);
    await writeFile(path.join(runtime, 'node_modules/example/package.json'), '{"name":"example","version":"9.0.0"}');
    assert.match(response(await invoke(f, ['doctor']), 1).runtime.reason, /pinned dependency/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('failed installs never activate a runtime and a subsequent setup succeeds', async () => {
  const f = await fixture();
  try {
    const failure = await invoke(f, ['setup'], { FAKE_NPM_FAIL: '1' });
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /no runtime was activated/);
    assert.deepEqual(await readdir(f.cache), []);
    assert.equal(response(await invoke(f, ['setup'])).runtime.ready, true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('successful dependency installation followed by a build failure remains unready', async () => {
  const f = await fixture();
  try {
    const failure = await invoke(f, ['setup'], { FAKE_COMPILER_FAIL: '1' });
    assert.equal(failure.code, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /TypeScript build failed with exit 19/);
    assert.deepEqual(await readdir(f.cache), []);
    assert.equal(response(await invoke(f, ['doctor']), 1).runtime.ready, false);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('normal commands use a verified runtime even if npm later becomes unavailable', async () => {
  const f = await fixture();
  try {
    response(await invoke(f, ['setup']));
    const noNpm = { npm_execpath: path.join(f.directory, 'missing-npm.js') };
    const doctor = response(await invoke(f, ['doctor'], noNpm), 1);
    assert.equal(doctor.npm.available, false);
    assert.equal(doctor.runtime.ready, true);
    assert.deepEqual(response(await invoke(f, ['schema'], noNpm)), { cwd: f.cwd, argv: ['schema'] });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('concurrent setup cannot modify the same runtime while installation is running', async () => {
  const f = await fixture();
  try {
    const first = invoke(f, ['setup'], { FAKE_NPM_DELAY_MS: '900' });
    await waitForLock(f);
    const second = await invoke(f, ['setup']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already locked/);
    assert.equal(response(await first).runtime.ready, true);
    assert.equal((await calls(f)).filter(call => call.args[0] === 'ci').length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('source changes during setup prevent activation and remove only the owned staging files', async () => {
  const f = await fixture();
  try {
    await mkdir(f.cache);
    await writeFile(path.join(f.cache, 'unrelated-user-file'), 'preserve');
    const setup = invoke(f, ['setup'], { FAKE_NPM_DELAY_MS: '500' });
    await waitForLock(f);
    await writeFile(path.join(f.plugin, 'templates/offline/target.mjs'), 'export const changed = true;');
    const failed = await setup;
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /source changed/);
    assert.deepEqual(await readdir(f.cache), ['unrelated-user-file']);
    assert.equal(await readFile(path.join(f.cache, 'unrelated-user-file'), 'utf8'), 'preserve');
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('nested environment files are rejected before dependencies can be installed', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.plugin, 'src', '.env.local'), 'SECRET=private');
    const result = await invoke(f, ['setup']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Environment files cannot be copied/);
    assert.deepEqual(await calls(f), []);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
