import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'data/expanded-20261002-bfcl');
const revision = 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function verify() {
  const provenance = JSON.parse(await readFile(path.join(output, 'provenance.json'), 'utf8'));
  if (provenance.revision !== revision || !Array.isArray(provenance.assets) || !provenance.assets.length) throw new Error('Unexpected BFCL fixture provenance');
  for (const asset of provenance.assets) {
    const file = path.resolve(output, asset.path);
    if (!file.startsWith(output + path.sep) || sha(await readFile(file)) !== asset.sha256) throw new Error(`BFCL source hash mismatch: ${asset.path}`);
  }
  const cases = (await readFile(path.join(output, 'bfcl.cases.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (cases.length !== 40) throw new Error('Expected 40 pinned BFCL fixture cases');
  return { revision, assets: provenance.assets.length, cases: cases.length };
}
try {
  await access(output);
  console.log(JSON.stringify({ reusedWithoutChanges: true, ...await verify() }));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // Never repair or overwrite an existing partially populated fixture directory.
  try { await access(output); throw new Error('Existing BFCL directory is incomplete; inspect it instead of overwriting evidence.'); }
  catch (check) { if (check.code !== 'ENOENT') throw check; }
  const command = process.env.ONE_EVAL_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(command, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (probe.status !== 0) throw new Error('Python is required to prepare the CI benchmark fixture');
  const temporaryRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(path.join(temporaryRoot, 'one-eval-ci-assets-'));
  try {
    const baseline = path.join(temporary, 'download-only-baseline.json');
    await writeFile(baseline, JSON.stringify({ target: { kind: 'module', config: { binaryPath: process.execPath, model: 'ci-assets-only-not-a-model' }, isolation: { mode: 'stateless', scope: 'independent', evidence: 'CI download fixture only; no model target will be executed. Node binary supplies a provenance hash and intentionally cannot pass the Codex version check.' }, retrySafe: false } }), { flag: 'wx' });
    const child = spawn(process.execPath, ['examples/benchmarks/bfcl/prepare.mjs', '--out', output, '--baseline', baseline, '--python', probe.stdout.trim()], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (code !== 0) throw new Error(`Pinned BFCL preparation failed with exit code ${code}`);
    console.log(JSON.stringify({ downloadedOnly: true, modelInvoked: false, ...await verify() }));
  } finally {
    const stat = await lstat(temporary);
    if (path.dirname(temporary) !== temporaryRoot || !path.basename(temporary).startsWith('one-eval-ci-assets-') || stat.isSymbolicLink() || await realpath(temporary) !== temporary) throw new Error('Refusing cleanup outside the owned temporary directory');
    await rm(temporary, { recursive: true, force: false });
  }
}
