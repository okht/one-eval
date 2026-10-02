import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/benchmarks/codex-target.mjs');
const { createTarget } = await import(pathToFileURL(modulePath).href);

const mockSource = `
import { appendFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const mode = process.env.MOCK_MODE;
if (args.includes('--version')) { console.log(mode === 'wrong-version' ? 'codex-cli 9.9.9' : 'codex-cli 0.144.6'); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const entry = {args,input,cwd:process.cwd(),pid:process.pid};
if (mode === 'hang') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
  entry.descendantPid = descendant.pid;
}
await appendFile(process.env.MOCK_LOG, JSON.stringify(entry)+'\\n');
function event(value) { console.log(JSON.stringify(value)); }
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'bad-json') { console.log('broken JSON'); }
else if (mode === 'overflow') { process.stdout.write('x'.repeat(1024*1024+1)); }
else {
  event({type:'thread.started',thread_id:mode === 'same-thread' ? 'shared-thread' : 'thread-'+process.pid});
  event({type:'turn.started'});
  if (mode === 'structured-error' || mode === 'turn-failed') {
    const detail = {message:'Too many requests; api_key=private-key Authorization: Bearer private-token',code:'rate_limit_exceeded',status_code:429,request:{secret:'do-not-copy'}};
    event(mode === 'structured-error' ? {type:'error',...detail} : {type:'turn.failed',error:detail});
  } else if (mode === 'tool') {
    event({type:'item.started',item:{id:'cmd-1',type:'command_execution',command:'read reference'}});
    setInterval(() => {}, 1000);
  } else {
    event({type:'item.completed',item:{id:'reasoning-1',type:'reasoning',text:'A brief reasoning summary.'}});
    if (mode !== 'no-message') event({type:'item.completed',item:{id:'answer-1',type:'agent_message',text:'result:'+input}});
    event({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3}});
    if (mode === 'two-turns') event({type:'turn.completed',usage:{input_tokens:10,output_tokens:3}});
    if (mode === 'nonzero') process.exitCode=2;
  }
}
`;

async function fixture(context: any, mode = 'normal') {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-benchmark-test-'));
  context.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('one-eval-benchmark-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const mock = path.join(directory, 'mock.mjs');
  const log = path.join(directory, 'calls.jsonl');
  await writeFile(mock, mockSource);
  const spawnProcess = (_binary: string, args: string[], options: any) => spawn(process.execPath, [mock, ...args], {
    ...options, env: { ...options.env, MOCK_MODE: mode, MOCK_LOG: log },
  });
  const adapter = await createTarget({ binaryPath: process.execPath, model: 'fixture-model' }, { spawnProcess });
  context.after(() => adapter.close());
  let next = 0;
  function trial() {
    const controller = new AbortController();
    return { context: { runId: 'run', trialId: `trial-${++next}`, caseId: 'SECRET_REFERENCE_CASE_ID', repeat: 0,
      attempt: 1, sessionId: `session-${next}`, signal: controller.signal, workDir: directory, baseDir: directory }, controller };
  }
  return { adapter, trial, log, directory, spawnProcess };
}

async function entries(log: string): Promise<any[]> {
  try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

async function waitForEntry(log: string): Promise<any> {
  for (let count = 0; count < 200; count++) {
    const result = (await entries(log))[0];
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Mock child did not start');
}

async function eventuallyExited(pid: number) {
  for (let count = 0; count < 100; count++) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Process ${pid} survived cleanup`);
}

test('Codex adapter uses fresh directories and threads, and passes only user content', async (t) => {
  const { adapter, trial, log } = await fixture(t);
  const outputs = [];
  const directories = [];
  for (let index = 0; index < 2; index++) {
    const { context } = trial();
    const session = await adapter.prepare(context);
    directories.push(session.directory);
    assert.equal((await adapter.verify(session, context)).ok, true);
    assert.equal(path.dirname(session.directory), path.resolve(tmpdir()));
    const output = await adapter.execute([{ role: 'user', content: `Question ${index}\nUnicode: 中文` }], session, context);
    assert.equal(output.output, `result:Question ${index}\nUnicode: 中文`);
    assert.equal(output.metadata.cliVersion, 'codex-cli 0.144.6');
    assert.equal(output.tokenUsage.input, 10);
    assert.equal(output.metadata.events.at(-1).type, 'turn.completed');
    outputs.push(output);
    await assert.rejects(adapter.execute([{ role: 'user', content: 'again' }], session, context), /only one execute/);
    await adapter.cleanup(session, context);
    await assert.rejects(access(session.directory), { code: 'ENOENT' });
  }
  assert.notEqual(directories[0], directories[1]);
  assert.notEqual(outputs[0].metadata.threadId, outputs[1].metadata.threadId);
  const calls = await entries(log);
  assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.input, `Question ${index}\nUnicode: 中文`);
    assert.equal(call.args[0], 'exec');
    assert.equal(call.args.at(-1), '-');
    assert.ok(call.args.includes('--ephemeral'));
    assert.ok(call.args.includes('--ignore-user-config'));
    assert.ok(call.args.includes('project_doc_max_bytes=0'));
    assert.ok(call.args.includes('features.memories=false'));
    assert.ok(call.args.includes('features.shell_tool=false'));
    assert.ok(!JSON.stringify(call.args).includes('SECRET_REFERENCE_CASE_ID'));
    assert.ok(!call.args.includes('resume'));
  }
});

test('Codex adapter rejects mismatched sessions, nonempty directories and multi-turn input', async (t) => {
  const { adapter, trial, log, directory } = await fixture(t);
  const { context } = trial();
  const session = await adapter.prepare(context);
  await writeFile(path.join(session.directory, 'unexpected.txt'), 'unexpected');
  assert.equal((await adapter.verify(session, context)).ok, false);
  await assert.rejects(adapter.cleanup({ ...session, directory }, context), /mismatched session/);
  await access(path.join(directory, 'mock.mjs'));
  await assert.rejects(adapter.execute([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }], session, context), /exactly one user message/);
  assert.equal((await entries(log)).length, 0);
});

test('Codex adapter abort kills the child process tree before cleanup completes', { timeout: 15000 }, async (t) => {
  const { adapter, trial, log } = await fixture(t, 'hang');
  const { context, controller } = trial();
  const session = await adapter.prepare(context);
  const execution = adapter.execute([{ role: 'user', content: 'wait' }], session, context);
  const rejected = assert.rejects(execution, /aborted/);
  const call = await waitForEntry(log);
  controller.abort();
  await rejected;
  await adapter.cleanup(session, context);
  await eventuallyExited(call.pid);
  await eventuallyExited(call.descendantPid);
  await assert.rejects(access(session.directory), { code: 'ENOENT' });
});

for (const [mode, expected] of [
  ['tool', /tool or unsupported item/], ['bad-json', /malformed JSONL/],
  ['no-message', /requires a thread ID/], ['two-turns', /exactly one turn/],
  ['overflow', /output exceeded/], ['nonzero', /CLI exited with 2/],
] as const) {
  test(`Codex adapter rejects ${mode} and leaves no live process`, { timeout: 15000 }, async (t) => {
    const { adapter, trial, log } = await fixture(t, mode);
    const { context } = trial();
    const session = await adapter.prepare(context);
    await assert.rejects(adapter.execute([{ role: 'user', content: 'question' }], session, context), expected);
    await adapter.cleanup(session, context);
    const call = (await entries(log))[0];
    await eventuallyExited(call.pid);
  });
}

test('Codex adapter rejects a reused thread ID across independent trials', async (t) => {
  const { adapter, trial } = await fixture(t, 'same-thread');
  const first = trial();
  const firstSession = await adapter.prepare(first.context);
  await adapter.execute([{ role: 'user', content: 'one' }], firstSession, first.context);
  await adapter.cleanup(firstSession, first.context);
  const second = trial();
  const secondSession = await adapter.prepare(second.context);
  await assert.rejects(adapter.execute([{ role: 'user', content: 'two' }], secondSession, second.context), /reused thread ID/);
});

test('Codex adapter refuses a different CLI version before any model execution', async (t) => {
  await assert.rejects(fixture(t, 'wrong-version'), /expected codex-cli 0.144.6/);
});

test('Codex adapter validates its module-specific configuration before spawning', async () => {
  await assert.rejects(createTarget({ binaryPath: 'codex' }), /absolute native executable/);
  await assert.rejects(createTarget({ binaryPath: process.execPath, model: '' }), /nonempty string/);
  await assert.rejects(createTarget({ binaryPath: process.execPath, reference: 'must never be sent' }), /accepts only binaryPath/);
});

for (const mode of ['structured-error', 'turn-failed']) {
  test(`Codex adapter preserves ${mode} diagnostics and redacts credentials`, async (t) => {
    const { adapter, trial } = await fixture(t, mode);
    const { context } = trial();
    const session = await adapter.prepare(context);
    await assert.rejects(adapter.execute([{ role: 'user', content: 'question' }], session, context), (error: any) => {
      assert.equal(error.code, 'rate_limit_exceeded');
      assert.equal(error.statusCode, 429);
      assert.equal(error.cause.code, 'rate_limit_exceeded');
      assert.match(error.cause.threadId, /^thread-/);
      assert.match(error.message, /Too many requests/);
      for (const secret of ['private-key', 'private-token', 'do-not-copy']) {
        assert.ok(!error.message.includes(secret));
        assert.ok(!JSON.stringify(error.cause).includes(secret));
      }
      return true;
    });
    await adapter.cleanup(session, context);
  });
}
