#!/usr/bin/env node
// A dependency-free bridge. Dependencies are installed only by explicit `setup`.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const minimumNode = '22.22.0';
const format = 1;
const markerName = '.one-eval-plugin-runtime.json';
const inputFiles = ['package.json', 'package-lock.json', 'tsconfig.json'];
const inputDirectories = ['src', 'templates'];
const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => `${JSON.stringify(value)}\n`;
const nodeSupported = () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 22);
};
const isInside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const safeRelative = value => typeof value === 'string' && value !== '' && !value.includes('\\') && !path.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

async function regularFile(file, base) {
  if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular file: ${file}`);
  if (!isInside(base, await realpath(file))) throw new Error(`File escapes its runtime directory: ${file}`);
}

async function treeFiles(base, relative) {
  const absolute = path.join(base, relative);
  if (!(await lstat(absolute)).isDirectory()) throw new Error(`Expected a real directory: ${absolute}`);
  const files = [];
  for (const entry of (await readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name === '.env' || entry.name.startsWith('.env.')) throw new Error(`Environment files cannot be copied into a plugin runtime: ${path.join(absolute, entry.name)}`);
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await treeFiles(base, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Symlinks and special files are not supported in plugin runtime inputs: ${child}`);
  }
  return files;
}

async function inventory(base, files) {
  const entries = [];
  for (const file of [...new Set(files)].sort()) {
    if (!safeRelative(file)) throw new Error(`Unsafe runtime inventory path: ${file}`);
    const absolute = path.join(base, file);
    await regularFile(absolute, base);
    const content = await readFile(absolute);
    entries.push({ file, bytes: content.length, sha256: hash(content) });
  }
  return entries;
}

async function sourceState() {
  const sourceRoot = await realpath(root);
  const files = [...inputFiles];
  for (const directory of inputDirectories) files.push(...await treeFiles(sourceRoot, directory));
  const inputs = await inventory(sourceRoot, files);
  const bridgeHash = hash(await readFile(fileURLToPath(import.meta.url)));
  const sourceHash = hash(JSON.stringify({ format, bridgeHash, inputs }));
  const key = hash(JSON.stringify({ sourceHash, node: process.versions.node, platform: process.platform, arch: process.arch }));
  const configured = process.env.ONE_EVAL_PLUGIN_CACHE_DIR;
  const defaultRoot = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'one-eval', 'codex-plugin')
    : path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'one-eval', 'codex-plugin');
  const cacheRoot = path.resolve(configured || defaultRoot);
  return { sourceRoot, sourceHash, key, inputs, cacheRoot, directory: path.join(cacheRoot, key) };
}

async function runtimeFiles(directory) {
  const files = [...inputFiles];
  for (const relative of [...inputDirectories, 'dist']) files.push(...await treeFiles(directory, relative));
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const dependencies = { ...metadata.dependencies, ...metadata.devDependencies };
  const installed = {};
  for (const name of Object.keys(dependencies).sort()) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error(`Invalid dependency name: ${name}`);
    const file = `node_modules/${name}/package.json`;
    await regularFile(path.join(directory, file), directory);
    const info = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    if (info.name !== name || typeof info.version !== 'string') throw new Error(`Invalid installed dependency metadata: ${name}`);
    if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(dependencies[name]) && info.version !== dependencies[name]) throw new Error(`Installed version does not match the pinned dependency: ${name}`);
    installed[name] = info.version;
    files.push(file);
  }
  return { files, installed };
}

async function readiness(state) {
  try {
    if (!(await lstat(state.directory)).isDirectory()) throw new Error('Runtime path must be a real directory');
    const directory = await realpath(state.directory);
    const markerFile = path.join(directory, markerName);
    await regularFile(markerFile, directory);
    const marker = JSON.parse(await readFile(markerFile, 'utf8'));
    if (marker.format !== format || marker.key !== state.key || marker.sourceHash !== state.sourceHash || marker.node !== process.versions.node || marker.platform !== process.platform || marker.arch !== process.arch) throw new Error('Runtime completion marker does not match this source and Node runtime');
    const { files, installed } = await runtimeFiles(directory);
    const current = await inventory(directory, files);
    if (JSON.stringify(current) !== JSON.stringify(marker.inventory) || JSON.stringify(installed) !== JSON.stringify(marker.dependencies)) throw new Error('Runtime files or installed dependency metadata changed after setup');
    await regularFile(path.join(directory, 'dist', 'cli.js'), directory);
    return { ready: true, key: state.key, directory: state.directory, sourceHash: state.sourceHash };
  } catch (error) {
    return { ready: false, key: state.key, directory: state.directory, sourceHash: state.sourceHash, reason: error.code === 'ENOENT' ? 'Runtime has not been completely installed' : error.message };
  }
}

async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

async function npmCommand() {
  const inherited = process.env.npm_execpath;
  if (inherited) {
    const file = path.resolve(inherited);
    if (!/\.(?:c?js|mjs)$/i.test(file) || !(await lstat(file)).isFile()) throw new Error('npm_execpath must identify an existing JavaScript npm CLI');
    return { command: process.execPath, prefix: [file] };
  }
  const nodeDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ...process.env.PATH?.split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')) || [],
  ];
  for (const file of candidates) if (await exists(file)) return { command: process.execPath, prefix: [file] };
  for (const directory of process.env.PATH?.split(path.delimiter).filter(Boolean) || []) {
    const file = path.join(directory, process.platform === 'win32' ? 'npm.exe' : 'npm');
    if (!(await exists(file))) continue;
    const resolved = await realpath(file);
    if (/\.(?:c?js|mjs)$/i.test(resolved)) return { command: process.execPath, prefix: [resolved] };
    // Never interpolate npm.cmd or PowerShell wrapper paths into a shell command.
    return { command: file, prefix: [] };
  }
  throw new Error('npm was not found. Install Node.js with npm or provide its JavaScript CLI through npm_execpath.');
}

function child(command, args, { cwd, capture = false, diagnostics = false, timeout } = {}) {
  return new Promise((resolve, reject) => {
    // Setup diagnostics go directly to the parent's stderr descriptor. This
    // streams both child channels without retaining or replaying their output.
    const stdio = capture ? ['ignore', 'pipe', 'pipe'] : diagnostics ? ['ignore', 2, 2] : ['inherit', 'inherit', 'inherit'];
    const subprocess = spawn(command, args, { cwd, env: process.env, shell: false, windowsHide: true, stdio });
    let stdout = ''; let stderr = '';
    if (capture) {
      subprocess.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
      subprocess.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    }
    const timer = timeout ? setTimeout(() => { subprocess.kill(); reject(new Error(`Child process timed out after ${timeout} ms`)); }, timeout) : undefined;
    subprocess.once('error', error => { clearTimeout(timer); reject(error); });
    subprocess.once('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? 1, signal, stdout, stderr }); });
  });
}

async function npmStatus() {
  try {
    const invocation = await npmCommand();
    const result = await child(invocation.command, [...invocation.prefix, '--version'], { capture: true, timeout: 15000 });
    if (result.code !== 0 || !/^\d+\.\d+\.\d+/.test(result.stdout.trim())) throw new Error(`npm version check failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    return { available: true, version: result.stdout.trim() };
  } catch (error) { return { available: false, reason: error.message }; }
}

async function doctor() {
  const npm = await npmStatus();
  let runtime;
  try { runtime = await readiness(await sourceState()); }
  catch (error) { runtime = { ready: false, reason: error.message }; }
  const ok = nodeSupported() && npm.available && runtime.ready;
  process.stdout.write(json({ ok, name: 'one-eval-codex-plugin', node: { version: process.versions.node, minimum: minimumNode, supported: nodeSupported() }, npm, runtime, integrityScope: 'Copied source, configuration, templates, build output, and direct dependency package metadata; dependency contents are not a sandbox or fully attested.' }));
  process.exitCode = ok ? 0 : 1;
}

async function cleanupStage(cacheRoot, stage, key) {
  if (!isInside(cacheRoot, stage) || path.dirname(stage) !== cacheRoot || !path.basename(stage).startsWith(`.staging-${key}-`)) throw new Error('Refusing to remove a staging directory outside this setup');
  if (!(await lstat(stage)).isDirectory()) throw new Error('Refusing to remove a staging path that is not a real directory');
  await rm(stage, { recursive: true });
}

async function setup() {
  const state = await sourceState();
  const current = await readiness(state);
  if (current.ready) { process.stdout.write(json({ ok: true, alreadyReady: true, runtime: current })); return; }
  const npm = await npmCommand();
  const status = await npmStatus();
  if (!status.available) throw new Error(status.reason);
  await mkdir(state.cacheRoot, { recursive: true });
  const cacheRoot = await realpath(state.cacheRoot);
  const finalDirectory = path.join(cacheRoot, state.key);
  const lockPath = path.join(cacheRoot, `.setup-${state.key}.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Setup is already locked: ${lockPath}. Wait for the other setup; if its process has stopped, inspect and remove this lock before retrying.`);
    throw error;
  }
  let stage;
  try {
    await lock.writeFile(json({ pid: process.pid, host: hostname(), key: state.key, createdAt: new Date().toISOString() }));
    // Recheck after taking the lock, including a setup that finished during npm discovery.
    const completed = await readiness(state);
    if (completed.ready) { process.stdout.write(json({ ok: true, alreadyReady: true, runtime: completed })); return; }
    if (await exists(finalDirectory)) throw new Error(`An incomplete or modified runtime already exists at ${finalDirectory}. Preserve any evidence you need, then move this directory aside and rerun setup. Existing files were not changed.`);
    stage = path.join(cacheRoot, `.staging-${state.key}-${randomUUID()}`);
    await mkdir(stage);
    for (const entry of state.inputs) {
      const destination = path.join(stage, entry.file);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(state.sourceRoot, entry.file), destination, constants.COPYFILE_EXCL);
    }
    if (JSON.stringify(await inventory(stage, state.inputs.map(entry => entry.file))) !== JSON.stringify(state.inputs)) throw new Error('Plugin source changed while setup was copying it; retry with a stable source checkout');
    process.stderr.write('Installing the locked one-eval runtime with lifecycle scripts disabled.\n');
    // Keep installation progress visible while preserving one JSON stdout value.
    const installation = await child(npm.command, [...npm.prefix, 'ci', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'], { cwd: stage, diagnostics: true });
    if (installation.code !== 0) throw new Error(`npm ci failed with exit ${installation.code}; no runtime was activated`);
    const compiler = path.join(stage, 'node_modules', 'typescript', 'bin', 'tsc');
    await regularFile(compiler, stage);
    process.stderr.write('Building the one-eval runtime.\n');
    const build = await child(process.execPath, [compiler, '-p', path.join(stage, 'tsconfig.json')], { cwd: stage, diagnostics: true });
    if (build.code !== 0) throw new Error(`TypeScript build failed with exit ${build.code}; no runtime was activated`);
    await regularFile(path.join(stage, 'dist', 'cli.js'), stage);
    if ((await sourceState()).key !== state.key) throw new Error('Plugin source changed during setup; retry with a stable source checkout');
    const { files, installed } = await runtimeFiles(stage);
    const marker = { format, key: state.key, sourceHash: state.sourceHash, node: process.versions.node, platform: process.platform, arch: process.arch, createdAt: new Date().toISOString(), dependencies: installed, inventory: await inventory(stage, files), integrityScope: 'Copied inputs and build output plus direct dependency package metadata; not all node_modules contents.' };
    await writeFile(path.join(stage, markerName), json(marker), { flag: 'wx' });
    await rename(stage, finalDirectory);
    stage = undefined;
    const ready = await readiness(state);
    if (!ready.ready) throw new Error(`Installed runtime failed verification: ${ready.reason}`);
    process.stdout.write(json({ ok: true, alreadyReady: false, runtime: ready }));
  } finally {
    try { if (stage) await cleanupStage(cacheRoot, stage, state.key); }
    finally {
      try { await lock.close(); }
      finally { await rm(lockPath); }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'doctor') {
    if (args.length !== 1) throw new Error('doctor accepts no arguments');
    await doctor(); return;
  }
  if (!nodeSupported()) throw new Error(`Node.js >=${minimumNode} is required; current version is ${process.versions.node}`);
  if (args[0] === 'setup') {
    if (args.length !== 1) throw new Error('setup accepts no arguments');
    await setup(); return;
  }
  const runtime = await readiness(await sourceState());
  if (!runtime.ready) throw new Error(`Plugin setup is required: ${runtime.reason}. Run node "${fileURLToPath(import.meta.url)}" setup. Cache: ${runtime.directory}`);
  const result = await child(process.execPath, [path.join(runtime.directory, 'dist', 'cli.js'), ...args], { cwd: process.cwd() });
  process.exitCode = result.code;
}

try { await main(); }
catch (error) {
  process.stderr.write(json({ error: { message: error.message } }));
  process.exitCode = 1;
}
