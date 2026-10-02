import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI_VERSION = 'codex-cli 0.144.6';
const DIRECTORY_PREFIX = 'one-eval-codex-';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DISABLED_FEATURES = [
  'shell_tool', 'memories', 'apps', 'plugins', 'multi_agent', 'browser_use',
  'computer_use', 'image_generation', 'code_mode_host', 'shell_snapshot',
];

function fail(message) { return new Error(`Codex target: ${message}`); }

function safeErrorText(value) {
  return String(value)
    .replace(/(\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';&}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]').slice(0, 4000);
}

function cliEventError(event, threadId) {
  const detail = event.error && typeof event.error === 'object' ? event.error : event;
  const message = typeof event.error === 'string' ? event.error : detail.message ?? event.message ?? 'No error message supplied';
  const code = detail.code ?? event.code ?? detail.error_code ?? event.error_code;
  const statusCode = detail.statusCode ?? detail.status_code ?? detail.status ?? event.status_code;
  // Preserve diagnostic fields without copying request bodies, credentials, or arbitrary provider payloads.
  const cause = {
    eventType: event.type, message: safeErrorText(message),
    ...(typeof code === 'string' || typeof code === 'number' ? { code: safeErrorText(code).slice(0, 100) } : {}),
    ...(Number.isInteger(statusCode) ? { statusCode } : {}),
    ...(threadId ? { threadId } : {}),
  };
  return Object.assign(new Error(`Codex target: CLI reported ${event.type}: ${JSON.stringify(cause)}`, { cause }), {
    code: cause.code ?? 'CODEX_ERROR', ...(cause.statusCode === undefined ? {} : { statusCode: cause.statusCode }),
  });
}

async function terminateTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      killer.once('error', reject);
      killer.once('close', (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(fail(`process-tree termination failed with exit code ${code}`));
      });
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

// The second argument is a test-only dependency seam. Configuration cannot override process control.
export async function createTarget(config = {}, dependencies = {}) {
  const { binaryPath, model } = config;
  if (Object.keys(config).some((key) => !['binaryPath', 'model'].includes(key))) {
    throw fail('configuration accepts only binaryPath and optional model');
  }
  if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath) || !(await stat(binaryPath)).isFile()) {
    throw fail('binaryPath must identify an existing absolute native executable');
  }
  if (process.platform === 'win32' && path.extname(binaryPath).toLowerCase() !== '.exe') {
    throw fail('Windows binaryPath must be a native .exe, not a shell shim');
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw fail('model must be a nonempty string when supplied');
  }
  const spawnProcess = dependencies.spawnProcess ?? spawn;
  const sessions = new Map();
  const seenThreads = new Set();
  const temporaryRoot = await realpath(tmpdir());

  function start(args, { input = '', cwd, signal, onLine, timeoutMs } = {}) {
    signal?.throwIfAborted();
    const child = spawnProcess(binaryPath, args, {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    });
    let failure;
    let bytes = 0;
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let closed = false;
    let termination;
    let timer;
    const stop = (error) => {
      failure ??= error;
      if (!closed && !termination) {
        // The operation stays pending until close: recovery must never race a live process.
        termination = terminateTree(child).catch((cause) => {
          failure = fail(`${failure.message}; ${cause.message}`);
          try { child.kill('SIGKILL'); } catch { /* close remains the required completion signal */ }
        });
      }
    };
    const parseLine = (line) => {
      if (!line.trim() || failure) return;
      try { onLine?.(line); } catch (error) { stop(error); }
    };
    const aborted = () => stop(fail('trial aborted; child process tree is being terminated'));
    const done = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return stop(fail('CLI output exceeded the 1 MiB limit'));
        stdout += chunk;
        if (onLine) {
          lineBuffer += chunk;
          let newline;
          while ((newline = lineBuffer.indexOf('\n')) >= 0) {
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            parseLine(line);
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        if (failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) return stop(fail('CLI output exceeded the 1 MiB limit'));
        stderr += chunk;
      });
      child.once('error', (error) => { failure ??= error; });
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') stop(error); });
      child.once('close', async (code, processSignal) => {
        closed = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (onLine) parseLine(lineBuffer);
        await termination;
        if (failure) return reject(failure);
        if (code !== 0) return reject(Object.assign(fail(`CLI exited with ${code ?? processSignal}: ${safeErrorText(stderr).slice(0, 2000)}`), { code: 'PROCESS_EXIT' }));
        resolve({ stdout, stderr });
      });
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      if (timeoutMs) timer = setTimeout(() => stop(fail('CLI version check timed out')), timeoutMs);
      child.stdin.end(input);
    });
    return { child, done, stop, get closed() { return closed; } };
  }

  const version = await start(['--version'], { timeoutMs: 5000 }).done;
  if (version.stdout.trim() !== CLI_VERSION) {
    throw fail(`expected ${CLI_VERSION}, received ${version.stdout.trim() || '(empty version)'}`);
  }

  function sessionState(session, context) {
    const state = sessions.get(session?.sessionId);
    if (!state || state.directory !== session.directory || session.sessionId !== context.sessionId) {
      throw fail('unknown or mismatched session');
    }
    return state;
  }

  async function removeOwnedDirectory(state) {
    if (path.dirname(state.directory) !== temporaryRoot || !path.basename(state.directory).startsWith(DIRECTORY_PREFIX)) {
      throw fail('refusing to remove a directory outside the owned temporary root');
    }
    let info;
    try { info = await lstat(state.directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(state.directory) !== state.directory) {
      throw fail('owned temporary directory was replaced or redirected');
    }
    await rm(state.directory, { recursive: true, force: false });
  }

  async function release(state) {
    if (state.operation && !state.operation.closed) {
      state.operation.stop(fail('session cleanup requested'));
    }
    if (state.operation) await state.operation.done.catch(() => {});
    if (state.operation && !state.operation.closed) throw fail('child process has not exited');
    await removeOwnedDirectory(state);
    sessions.delete(state.id);
  }

  return {
    async prepare(context) {
      context.signal.throwIfAborted();
      if (sessions.has(context.sessionId)) throw fail('session ID was reused');
      const directory = await mkdtemp(path.join(temporaryRoot, DIRECTORY_PREFIX));
      const state = { id: context.sessionId, directory, executed: false, operation: undefined };
      sessions.set(context.sessionId, state);
      return { sessionId: context.sessionId, directory };
    },
    async verify(session, context) {
      context.signal.throwIfAborted();
      const state = sessionState(session, context);
      const info = await lstat(state.directory);
      const ok = !state.executed && !info.isSymbolicLink() && info.isDirectory() &&
        await realpath(state.directory) === state.directory && (await readdir(state.directory)).length === 0;
      return { ok, evidence: 'Fresh owned system-temporary directory; single new ephemeral CLI process per trial; memory and tools disabled. Remote hidden state is not independently verified.' };
    },
    async execute(messages, session, context) {
      context.signal.throwIfAborted();
      const state = sessionState(session, context);
      if (state.executed) throw fail('each session permits only one execute call');
      if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user' || typeof messages[0].content !== 'string') {
        throw fail('this benchmark adapter accepts exactly one user message');
      }
      state.executed = true;
      const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--cd', state.directory,
        '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
        ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
        ...(model ? ['--model', model] : []), '-'];
      const events = [];
      let threadId;
      let completed = 0;
      let finalOutput;
      let usage;
      const onLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { throw fail('CLI stdout contained malformed JSONL'); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
          throw fail('CLI event must be an object with a type');
        }
        events.push(event);
        if (event.type === 'error' || event.type === 'turn.failed') throw cliEventError(event, threadId);
        if (event.type === 'thread.started') {
          if (threadId || typeof event.thread_id !== 'string' || !event.thread_id.trim() || seenThreads.has(event.thread_id)) {
            throw fail('CLI returned a missing, repeated, or reused thread ID');
          }
          threadId = event.thread_id;
          seenThreads.add(threadId);
        } else if (event.type === 'turn.completed') {
          if (++completed !== 1) throw fail('CLI must complete exactly one turn');
          usage = event.usage;
        } else if (event.type.startsWith('item.')) {
          if (!['item.started', 'item.updated', 'item.completed'].includes(event.type) ||
            !event.item || !['reasoning', 'agent_message'].includes(event.item.type)) {
            throw fail(`tool or unsupported item detected: ${event.item?.type ?? event.type}`);
          }
          if (completed) throw fail('CLI emitted an item after turn completion');
          if (event.type === 'item.completed' && event.item.type === 'agent_message') {
            if (typeof event.item.text !== 'string') throw fail('agent_message text must be a string');
            finalOutput = event.item.text;
          }
        } else if (event.type !== 'turn.started') throw fail(`unsupported CLI event: ${event.type}`);
      };
      state.operation = start(args, { input: messages[0].content, cwd: state.directory, signal: context.signal, onLine });
      await state.operation.done;
      context.signal.throwIfAborted();
      if (!threadId || completed !== 1 || finalOutput === undefined) throw fail('CLI response requires a thread ID, one completed turn, and an agent_message');
      if (!usage || typeof usage !== 'object' || Array.isArray(usage) ||
        Object.values(usage).some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw fail('CLI token usage must contain finite nonnegative numbers');
      }
      const tokenUsage = {
        ...(typeof usage.input_tokens === 'number' ? { input: usage.input_tokens } : {}),
        ...(typeof usage.output_tokens === 'number' ? { output: usage.output_tokens } : {}),
        ...(typeof usage.cached_input_tokens === 'number' ? { cached: usage.cached_input_tokens } : {}),
      };
      return { output: finalOutput, tokenUsage, metadata: { cliVersion: CLI_VERSION, threadId, usage, events,
        ...(model ? { requestedModel: model } : {}) } };
    },
    async cleanup(session, context) { await release(sessionState(session, context)); },
    async close() { for (const state of [...sessions.values()]) await release(state); },
  };
}
