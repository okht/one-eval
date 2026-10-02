import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateStarter } from '../src/scaffold.js';
import { prepareGrading, preparePlan } from '../src/config.js';
import { runEvaluation } from '../src/execution.js';
import { gradeEvaluation } from '../src/grading.js';
import { calibrateGrading, probeExecution } from '../src/preflight.js';
import { buildReport } from '../src/report.js';
import { listArtifacts, readJson, writeJson } from '../src/storage.js';
import type { Message } from '../src/types.js';

async function workspace(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'one-eval-starter-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^one-eval-starter-/);
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function environment(t: TestContext, values: Record<string, string>) {
  const before = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test('offline starter completes the formal probe, execution, calibration, grading and report flow', async t => {
  const directory = path.join(await workspace(t), 'offline');
  const starter = await generateStarter({ directory, template: 'offline' });
  assert.deepEqual(starter.requiredEnv, []);
  assert.ok(starter.nextSteps.some(command => command.includes('--preflight runs/probe/admission.json')));
  assert.ok(starter.nextSteps.some(command => command.includes('--calibration runs/calibration/admission.json')));
  const prepared = await preparePlan(path.join(directory, 'eval.json'));
  assert.ok(prepared.files.some(file => path.basename(file.path) === 'target.mjs'));
  assert.match(prepared.plan.cases[1]!.input, /Café "first"\nsecond line/);
  const probe = await probeExecution(prepared, path.join(directory, 'runs', 'probe'));
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.ok(probe.receiptPath);
  const run = path.join(directory, 'runs', 'eval');
  const summary = await runEvaluation(prepared, run, { mode: 'formal', receipt: probe.receiptPath });
  assert.equal(summary.completed, 4);
  assert.equal(summary.failed, 0);
  const artifacts = await listArtifacts(run);
  assert.equal(new Set(artifacts.map(item => item.sessionId)).size, 4);
  for (const artifact of artifacts) {
    assert.equal(artifact.output, prepared.plan.cases.find(item => item.id === artifact.caseId)?.reference);
    assert.equal(artifact.isolation?.ok, true);
  }
  const grading = await prepareGrading(path.join(directory, 'judges.json'));
  assert.ok(grading.files.some(file => path.basename(file.path) === 'grade.mjs'));
  const calibration = await calibrateGrading(grading, path.join(directory, 'calibration.json'), path.join(directory, 'runs', 'calibration'));
  assert.equal(calibration.ok, true, JSON.stringify(calibration));
  assert.ok(calibration.receiptPath);
  await gradeEvaluation(run, grading, { mode: 'formal', receipt: calibration.receiptPath });
  const report = await buildReport(run);
  assert.equal(report.complete, true);
  assert.equal(report.overall, 1);
  assert.deepEqual(report.admission, { execution: 'formal', grading: 'formal' });
});

test('managed starter cannot claim successful remote isolation before its lifecycle is implemented', async t => {
  const directory = path.join(await workspace(t), 'managed');
  environment(t, { ONE_EVAL_ENDPOINT: 'http://127.0.0.1:1/unimplemented', ONE_EVAL_API_KEY: 'unused-local-placeholder' });
  await generateStarter({ directory, template: 'managed' });
  const prepared = await preparePlan(path.join(directory, 'eval.json'));
  assert.equal(prepared.plan.target.retrySafe, false);
  assert.deepEqual(prepared.plan.target.config, { endpoint: '${ENV:ONE_EVAL_ENDPOINT}', apiKey: '${ENV:ONE_EVAL_API_KEY}' });
  const result = await probeExecution(prepared, path.join(directory, 'probe'));
  assert.equal(result.ok, false);
  assert.equal(result.receiptPath, undefined);
  const artifacts = await listArtifacts(result.directory);
  assert.ok(artifacts.length > 0);
  assert.ok(artifacts.every(artifact => artifact.status !== 'completed' && artifact.output === undefined));
  assert.match(JSON.stringify(artifacts), /TODO managed prepare/);
});

for (const template of ['http', 'openai-compatible'] as const) {
  test(`${template} starter uses the installed provider and preserves real loopback messages exactly`, async t => {
    const directory = path.join(await workspace(t), template);
    const requests: { method?: string; url?: string; authorization?: string; body: { input?: unknown; messages: Message[]; sessionId?: string; model?: string } }[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      const output = body.messages.at(-1).content;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(template === 'http' ? { output } : {
        id: 'loopback-response', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: output }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${address.port}/${template === 'http' ? 'invoke' : 'v1'}`;
    const envNames = { endpointEnv: 'ONE_EVAL_TEST_ENDPOINT', apiKeyEnv: 'ONE_EVAL_TEST_KEY', modelEnv: 'ONE_EVAL_TEST_MODEL' };
    environment(t, { ONE_EVAL_TEST_ENDPOINT: endpoint, ONE_EVAL_TEST_KEY: 'loopback-only-secret', ONE_EVAL_TEST_MODEL: 'gateway/test-model' });
    await generateStarter({ directory, template, endpoint, model: 'gateway/test-model', ...envNames });
    const first = 'Café 中文 🙂 "quoted" \\\nnext line ${ENV:DO_NOT_RESOLVE} {{ 7 * 7 }}';
    const followup = 'Final "reply"\nwith a newline and a \\ backslash';
    const jsonText = '{"literal":"keep this as a string"}';
    await writeJson(path.join(directory, 'cases.json'), [
      { id: 'multiturn', input: first, reference: followup, conversation: { mode: 'scripted', turns: [followup] } },
      { id: 'json-looking', input: jsonText, reference: jsonText },
    ]);
    const prepared = await preparePlan(path.join(directory, 'eval.json'));
    assert.equal(prepared.plan.target.kind, 'provider');
    assert.equal(prepared.plan.target.isolation.mode, 'stateless');
    assert.match(prepared.plan.target.isolation.evidence, /not independently verified/);
    const savedConfig = await readFile(path.join(directory, 'eval.json'), 'utf8');
    assert.match(savedConfig, /\$\{ENV:ONE_EVAL_TEST_ENDPOINT\}/);
    for (const name of await readdir(directory)) {
      assert.equal((await readFile(path.join(directory, name), 'utf8')).includes('loopback-only-secret'), false, `Credential leaked to ${name}`);
    }
    const run = path.join(directory, 'run');
    const logs: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write;
      t.mock.method(stream, 'write', (...args: unknown[]) => {
        logs.push(String(args[0]));
        return Reflect.apply(original, stream, args);
      });
    }
    const summary = await runEvaluation(prepared, run, { mode: 'exploratory' });
    assert.equal(logs.join('').includes('loopback-only-secret'), false, 'Provider logs must not include the Authorization credential');
    assert.equal(summary.completed, 4, JSON.stringify(await listArtifacts(run)));
    assert.equal(summary.failed, 0);
    assert.equal(requests.length, 6);
    const histories: Message[][] = [
      [{ role: 'user', content: first }],
      [{ role: 'user', content: first }, { role: 'assistant', content: first }, { role: 'user', content: followup }],
      [{ role: 'user', content: jsonText }],
    ];
    for (const expected of histories) assert.equal(requests.filter(request => JSON.stringify(request.body.messages) === JSON.stringify(expected)).length, 2);
    for (const request of requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, template === 'http' ? '/invoke' : '/v1/chat/completions');
      assert.equal(request.authorization, 'Bearer loopback-only-secret');
      if (template === 'http') {
        assert.equal(typeof request.body.input, 'string');
        assert.equal(request.body.input, request.body.messages.at(-1)?.content);
        assert.equal(typeof request.body.sessionId, 'string');
      } else assert.equal(request.body.model, 'gateway/test-model');
    }
    if (template === 'http') assert.equal(new Set(requests.map(request => request.body.sessionId)).size, 4);
    for (const artifact of await listArtifacts(run)) assert.equal(artifact.output, artifact.caseId === 'multiturn' ? followup : jsonText);
  });
}

test('HTTP starter rejects non-2xx responses without provider retries or invented output', async t => {
  const directory = path.join(await workspace(t), 'http-error');
  let calls = 0;
  const server = createServer((request, response) => {
    calls++; request.resume(); response.writeHead(503, { 'Content-Type': 'application/json' }); response.end('{"output":"Do not score this failure"}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  environment(t, { ONE_EVAL_ENDPOINT: `http://127.0.0.1:${address.port}/invoke`, ONE_EVAL_API_KEY: 'local-placeholder' });
  await generateStarter({ directory, template: 'http' });
  const config = await readJson<any>(path.join(directory, 'eval.json'));
  config.execution.maxAttempts = 1;
  await writeJson(path.join(directory, 'eval.json'), config);
  const output = path.join(directory, 'run');
  const summary = await runEvaluation(await preparePlan(path.join(directory, 'eval.json')), output);
  assert.equal(calls, 1);
  assert.equal(summary.completed, 0);
  const artifacts = await listArtifacts(output);
  assert.equal(artifacts[0]?.status, 'execution_error');
  assert.equal(artifacts[0]?.output, undefined);
});

test('starter refuses occupied and linked directories and does not overwrite user files', async t => {
  const parent = await workspace(t);
  const directory = path.join(parent, 'existing');
  await mkdir(directory);
  await writeFile(path.join(directory, 'eval.json'), 'keep my bytes');
  await assert.rejects(generateStarter({ directory, template: 'offline' }), /not empty/);
  assert.equal(await readFile(path.join(directory, 'eval.json'), 'utf8'), 'keep my bytes');
  assert.deepEqual(await readdir(directory), ['eval.json']);
  const link = path.join(parent, 'linked');
  await symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(generateStarter({ directory: link, template: 'offline' }), /ordinary empty directory/);
});

test('concurrent starter initializations produce one intact winner without overwriting', async t => {
  const directory = path.join(await workspace(t), 'race');
  const results = await Promise.allSettled([
    generateStarter({ directory, template: 'offline' }),
    generateStarter({ directory, template: 'managed' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const winner = results.find(result => result.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  const config = await readJson<any>(path.join(directory, 'eval.json'));
  assert.equal(config.name, `${winner.value.template} integration starter`);
  assert.deepEqual(new Set(await readdir(directory)), new Set(winner.value.files));
  await preparePlan(path.join(directory, 'eval.json'));
  await prepareGrading(path.join(directory, 'judges.json'));
});

test('starter rejects embedded endpoint credentials and ambiguous environment names before writing', async t => {
  const directory = path.join(await workspace(t), 'invalid');
  for (const endpoint of ['https://user:password@example.com/v1', 'https://example.com/v1?api_key=secret', 'file:///tmp/api', 'https://example.com/v1\n']) {
    await assert.rejects(generateStarter({ directory, template: 'openai-compatible', endpoint }), /endpoint|credentials/);
  }
  await assert.rejects(generateStarter({ directory, template: 'http', endpointEnv: 'A-B' }), /variable identifiers/);
  await assert.rejects(generateStarter({ directory, template: 'http', endpointEnv: 'SAME', apiKeyEnv: 'SAME' }), /distinct/);
  await assert.rejects(readdir(directory), { code: 'ENOENT' });
});
