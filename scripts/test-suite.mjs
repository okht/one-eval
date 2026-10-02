import { spawn, spawnSync } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const suite = process.argv[2] ?? 'all';
const strict = process.argv.includes('--strict');
if (!['unit', 'integration', 'all'].includes(suite)) throw new Error('Suite must be unit, integration or all');
const integration = new Set(['benchmark-graders.test.ts', 'bfcl.test.ts', 'http.test.ts', 'cli.test.ts', 'agent-workflow.test.ts', 'benchmark-target.test.ts', 'acceptance.test.ts', 'acceptance-v2.test.ts', 'scaffold.test.ts']);
const files = (await readdir(path.join(root, 'tests'))).filter(name => name.endsWith('.test.ts')).sort().filter(name => suite === 'all' || (suite === 'integration') === integration.has(name));
if (!files.length) throw new Error('No tests selected');
const env = { ...process.env };
if (suite !== 'unit') {
  const command = env.ONE_EVAL_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const probe = spawnSync(command, ['-c', 'import json,sys; print(json.dumps({"version":list(sys.version_info[:3]),"executable":sys.executable}))'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (probe.status !== 0) throw new Error(`Python >=3.10 is required; set ONE_EVAL_TEST_PYTHON. ${probe.stderr || probe.error?.message || ''}`);
  const python = JSON.parse(probe.stdout);
  if (python.version[0] !== 3 || python.version[1] < 10) throw new Error('Python >=3.10 is required for benchmark integration tests');
  env.ONE_EVAL_TEST_PYTHON = python.executable;
  for (const file of ['bfcl.cases.jsonl', 'provenance.json', 'upstream/bfcl_eval/eval_checker/ast_eval/ast_checker.py']) {
    try { await access(path.join(root, 'data/expanded-20261002-bfcl', file)); }
    catch { throw new Error(`Missing pinned BFCL fixture ${file}. Run npm run prepare:ci before integration/CI tests.`); }
  }
}
console.error(`Running ${suite} suite: ${files.length} files${strict ? '; skipped tests are forbidden' : ''}`);
let output = '';
const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map(name => path.join('tests', name))], { cwd: root, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
child.stdout.setEncoding('utf8'); child.stdout.on('data', text => { output += text; process.stdout.write(text); });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
if (code !== 0) process.exitCode = Number(code ?? 1);
else if (strict) {
  const match = [...output.matchAll(/^# skipped (\d+)\r?$/gm)].at(-1);
  if (!match || Number(match[1]) !== 0) { console.error(`Strict CI requires a verified zero-skip summary; observed ${match?.[1] ?? 'no summary'}.`); process.exitCode = 1; }
}
