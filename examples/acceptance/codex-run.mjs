import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const EXPECTED_CLI_VERSION = 'codex-cli 0.144.6';
const DISABLED = ['shell_tool', 'memories', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'code_mode_host', 'shell_snapshot'];
const budgets = new Map();
let reservation = Promise.resolve();

export function argumentsFor({ model, threadId, ephemeral = true }) {
  return ['exec', ...(threadId ? ['resume', threadId] : []), '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
    ...(ephemeral ? ['--ephemeral'] : []), '--model', model,
    '-c', 'sandbox_mode="read-only"', '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="low"',
    ...DISABLED.flatMap(feature => ['-c', `features.${feature}=false`]), '-'];
}

export function parseEvents(stdout, expectedThreadId) {
  const events = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const starts = events.filter(event => event.type === 'thread.started');
  const completed = events.filter(event => event.type === 'turn.completed');
  const failures = events.filter(event => ['error', 'turn.failed'].includes(event.type));
  if (failures.length) throw new Error(`Codex CLI failure: ${JSON.stringify(failures)}`);
  if (starts.length !== 1 || typeof starts[0].thread_id !== 'string' || !starts[0].thread_id) throw new Error('Expected exactly one thread.started event');
  if (expectedThreadId && starts[0].thread_id !== expectedThreadId) throw new Error('Native resume changed the server-owned thread ID');
  if (completed.length !== 1) throw new Error('Expected exactly one completed turn');
  for (const event of events) {
    if (event.type.startsWith('item.') && !['reasoning', 'agent_message'].includes(event.item?.type)) throw new Error(`Unexpected tool activity: ${event.item?.type}`);
    if (!['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed'].includes(event.type)) throw new Error(`Unexpected CLI event: ${event.type}`);
  }
  const messages = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message');
  if (!messages.length || typeof messages.at(-1).item.text !== 'string') throw new Error('Missing final agent message');
  const usage = completed[0].usage;
  if (!usage || Object.values(usage).some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid token usage');
  return { output: messages.at(-1).item.text, threadId: starts[0].thread_id, usage, events };
}

async function reserve(evidenceDir, maxCalls, record) {
  const operation = reservation.then(async () => {
    const resolved = path.resolve(evidenceDir);
    await mkdir(resolved, { recursive: true });
    if (!budgets.has(resolved)) budgets.set(resolved, (await readdir(resolved)).filter(name => name.endsWith('.start.json')).length);
    const count = budgets.get(resolved);
    if (count >= maxCalls) throw new Error(`Acceptance call budget exhausted (${count}/${maxCalls})`);
    budgets.set(resolved, count + 1);
    await writeFile(path.join(resolved, `${record.callId}.start.json`), JSON.stringify(record, null, 2), { flag: 'wx' });
  });
  reservation = operation.catch(() => {});
  return operation;
}

async function terminate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') await new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
    killer.once('error', reject); killer.once('close', code => code === 0 || child.exitCode !== null ? resolve() : reject(new Error(`taskkill exited ${code}`)));
  });
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
}

export async function invokeCodex({ binaryPath, model, prompt, cwd, threadId, ephemeral = true, evidenceDir, maxCalls = 90, timeoutMs = 90000, signal }) {
  if (!path.isAbsolute(binaryPath) || !model || typeof prompt !== 'string' || !path.isAbsolute(evidenceDir)) throw new Error('Codex acceptance requires absolute binary/evidence paths, model and prompt');
  signal?.throwIfAborted();
  const callId = randomUUID();
  const args = argumentsFor({ model, threadId, ephemeral });
  const record = { callId, startedAt: new Date().toISOString(), requestedModel: model, expectedThreadId: threadId ?? null, ephemeral, cliVersion: EXPECTED_CLI_VERSION, args, prompt };
  await reserve(evidenceDir, maxCalls, record);
  let stdout = '', stderr = '', bytes = 0, failure, timer, termination;
  const child = spawn(binaryPath, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
  const stop = error => { failure ??= error; termination ??= terminate(child).catch(cause => { failure = new Error(`${failure.message}; termination: ${cause.message}`); child.kill(); }); };
  const aborted = () => stop(new Error('Codex acceptance call aborted'));
  const finished = new Promise((resolve, reject) => {
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    for (const [stream, append] of [[child.stdout, text => { stdout += text; }], [child.stderr, text => { stderr += text; }]]) {
      stream.on('data', text => { bytes += Buffer.byteLength(text); if (bytes > 2 * 1024 * 1024) stop(new Error('Codex acceptance output limit exceeded')); else append(text); });
    }
    child.once('error', error => { failure ??= error; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.once('close', async (exitCode, processSignal) => {
      clearTimeout(timer); signal?.removeEventListener('abort', aborted); await termination;
      const completed = { ...record, finishedAt: new Date().toISOString(), exitCode, processSignal, stdout, stderr };
      try {
        if (failure) throw failure;
        if (exitCode !== 0) throw new Error(`Codex exit ${exitCode ?? processSignal}: ${stderr.slice(-2000)}; stdout: ${stdout.slice(-2000)}`);
        const parsed = parseEvents(stdout, threadId);
        await writeFile(path.join(evidenceDir, `${callId}.result.json`), JSON.stringify({ ...completed, status: 'completed', ...parsed }, null, 2), { flag: 'wx' });
        resolve({ ...parsed, callId, requestedModel: model, cliVersion: EXPECTED_CLI_VERSION });
      } catch (error) {
        await writeFile(path.join(evidenceDir, `${callId}.result.json`), JSON.stringify({ ...completed, status: 'error', error: error.message }, null, 2), { flag: 'wx' }).catch(() => {});
        reject(error);
      }
    });
    timer = setTimeout(() => stop(new Error(`Codex acceptance exceeded ${timeoutMs} ms`)), timeoutMs);
    signal?.addEventListener('abort', aborted, { once: true }); if (signal?.aborted) aborted();
    child.stdin.end(prompt);
  });
  return finished;
}
