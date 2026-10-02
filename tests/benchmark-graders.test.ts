import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gsmGrader = path.join(root, 'examples', 'benchmarks', 'gsm8k-grade.mjs');
const ifevalGrader = path.join(root, 'examples', 'benchmarks', 'ifeval-grade.py');
const python = process.env.ONE_EVAL_TEST_PYTHON ?? 'python';

function run(command: string, args: string[], input: unknown, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Benchmark grader timed out')); }, 15_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(JSON.stringify(input));
  });
}

function input(output: string, reference: unknown = { answer: 'The answer is 1,234.\n#### 1,234' }) {
  return { case: { id: 'fixture', input: 'Original question', reference, weight: 1 }, artifact: { output }, judgeId: 'benchmark', repeat: 0, instructions: '' };
}

test('GSM8K applies the official marker, comma removal, and exact-string comparison', async () => {
  const examples = [
    { output: 'Reasoning\n#### 1,234', answer: '#### 1234', score: 1 },
    { output: '#### -1,234.5', answer: '#### -1234.5', score: 1 },
    { output: '#### 1235', answer: '#### 1234', score: 0 },
    { output: 'The answer is 1234', answer: '#### 1234', score: 0 },
    { output: '', answer: '#### 1234', score: 0 },
    { output: '#### 4.0', answer: '#### 4', score: 0 },
    { output: '#### 4\n#### 5', answer: '#### 4', score: 1 },
    { output: '####4', answer: '#### 4', score: 0 },
    { output: '####  4', answer: '#### 4', score: 0 },
    { output: '#### +4', answer: '#### 4', score: 0 },
  ];
  for (const example of examples) {
    const result = await run(process.execPath, [gsmGrader], input(example.output, { answer: example.answer }));
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, 'scored');
    assert.equal(value.score, example.score, JSON.stringify(example));
    assert.equal(JSON.parse(value.reason).correct, Boolean(example.score));
  }
});

test('GSM8K missing reference abstains from scoring and invalid present references fail', async () => {
  const missing = await run(process.execPath, [gsmGrader], input('#### 1234', null));
  assert.equal(missing.code, 0, missing.stderr);
  const value = JSON.parse(missing.stdout);
  assert.equal(value.status, 'insufficient_evidence');
  assert.equal(value.score, undefined);
  const malformed = await run(process.execPath, [gsmGrader], input('#### 1234', { answer: '1234' }));
  assert.notEqual(malformed.code, 0);
  assert.equal(malformed.stdout, '');
  assert.match(malformed.stderr, /reference answer/);
});

async function pythonAvailable(): Promise<boolean> {
  try { const result = await run(python, ['--version'], {}); return result.code === 0 && /Python 3\./.test(result.stdout + result.stderr); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function fakeOfficialPackage(t: { after(callback: () => Promise<void>): void }, unicode?: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-ifeval-protocol-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('one-eval-ifeval-protocol-'));
    await rm(directory, { recursive: true, force: true });
  });
  await mkdir(path.join(directory, 'instruction_following_eval'));
  await writeFile(path.join(directory, 'instruction_following_eval', '__init__.py'), '');
  await writeFile(path.join(directory, 'langdetect.py'), 'class DetectorFactory:\n    seed = None\n');
  // This stub tests the wrapper protocol, never the benchmark's actual rules.
  await writeFile(path.join(directory, 'instruction_following_eval', 'evaluation_lib.py'), `from dataclasses import dataclass
from types import SimpleNamespace
from langdetect import DetectorFactory
@dataclass
class InputExample:
    key: int
    prompt: str
    instruction_id_list: list
    kwargs: list
def test_instruction_following_strict(example, responses):
    assert DetectorFactory.seed == 0
    assert example.prompt == ${JSON.stringify(unicode ?? 'Original instruction prompt')}
    assert example.kwargs == ${JSON.stringify(unicode === undefined ? [{}, {}] : [{ keyword: unicode }, {}])}
    print(${JSON.stringify(unicode ?? 'official checker diagnostic')})
    if responses[example.prompt] == 'raise':
        raise RuntimeError('Official checker failed')
    decisions = [True, responses[example.prompt] == ${JSON.stringify(unicode ?? 'all pass')}]
    return SimpleNamespace(follow_all_instructions=all(decisions), follow_instruction_list=decisions)
def test_instruction_following_loose(example, responses):
    return SimpleNamespace(follow_all_instructions=True, follow_instruction_list=[True, True])
`);
  return directory;
}

const ifevalReference = { key: 7, prompt: 'Original instruction prompt', instruction_id_list: ['fixture:first', 'fixture:second'], kwargs: [{}, {}] };

test('IFEval command preserves UTF-8 prompts, rules, responses and diagnostics under a GBK locale', async (t) => {
  if (!await pythonAvailable()) return t.skip('Python 3 is required to test the Python wrapper protocol');
  const text = '中文测试😀：「双引号 \\"」与单引号\'和换行\n结束';
  const officialParent = await fakeOfficialPackage(t, text);
  const reference = { ...ifevalReference, prompt: text, kwargs: [{ keyword: text }, {}] };
  const result = await run(python, [ifevalGrader, officialParent], input(text, reference), { PYTHONIOENCODING: 'gbk' });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'scored');
  assert.equal(value.score, 1);
  assert.deepEqual(JSON.parse(value.reason).strict.follow_instruction_list, [true, true]);
  assert.equal(result.stderr.replace(/\r\n/g, '\n'), text + '\n');
});

test('IFEval wrapper uses strict all-pass score, records loose details, and isolates diagnostics', async (t) => {
  if (!await pythonAvailable()) return t.skip('Python 3 is required to test the Python wrapper protocol');
  const officialParent = await fakeOfficialPackage(t);
  for (const [output, score] of [['all pass', 1], ['partial pass', 0]] as const) {
    const result = await run(python, [ifevalGrader, officialParent], input(output, ifevalReference));
    assert.equal(result.code, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.status, 'scored');
    assert.equal(value.score, score);
    const details = JSON.parse(value.reason);
    assert.deepEqual(details.instruction_id_list, ifevalReference.instruction_id_list);
    assert.deepEqual(details.strict.follow_instruction_list, [true, score === 1]);
    assert.equal(details.strict.instruction_correct, 1 + score);
    assert.equal(details.strict.instruction_total, 2);
    assert.equal(details.loose.prompt_correct, 1);
    assert.match(result.stderr, /official checker diagnostic/);
  }
});

test('IFEval official exceptions and missing source fail without fabricating zero grades', async (t) => {
  if (!await pythonAvailable()) return t.skip('Python 3 is required to test the Python wrapper protocol');
  const officialParent = await fakeOfficialPackage(t);
  const result = await run(python, [ifevalGrader, officialParent], input('raise', ifevalReference));
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Official checker failed/);
  const missing = await run(python, [ifevalGrader, path.join(officialParent, 'missing')], input('all pass', ifevalReference));
  assert.notEqual(missing.code, 0);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /evaluation_lib.py was not found/);
});
