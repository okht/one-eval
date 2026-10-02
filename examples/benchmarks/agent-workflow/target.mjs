import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, realpath, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { initialState, TOOL_NAMES } from './fixture.mjs';

const CLI_VERSION = 'codex-cli 0.144.6';
const DIRECTORY_PREFIX = 'one-eval-workflow-';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const serverPath = fileURLToPath(new URL('./server.mjs', import.meta.url));
const DEFAULT_INSTRUCTIONS = 'You are a customer-service assistant. Continue the supplied conversation by responding to its latest user message. Use only the orders MCP tools for business facts and actions. Look up the actual order before acting. Ask for a missing order ID or refund reason. Issue a refund only when the user explicitly requests it; a status query alone does not authorize a refund. Unpaid, shipped, and ineligible orders cannot be refunded. Already-refunded orders must not receive a duplicate refund. Never claim success without tool evidence. State the actual refund ID when a refund is completed or already exists. Keep replies concise.';
const DISABLED_FEATURES = [
  'shell_tool', 'memories', 'apps', 'plugins', 'multi_agent', 'browser_use',
  'computer_use', 'image_generation', 'code_mode_host', 'shell_snapshot', 'hooks',
];

function fail(message) { return new Error(`Codex target: ${message}`); }

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
  const { binaryPath, model, enableTools = true, instructions = DEFAULT_INSTRUCTIONS } = config;
  if (Object.keys(config).some((key) => !['binaryPath', 'model', 'enableTools', 'instructions'].includes(key))) {
    throw fail('configuration accepts binaryPath, model, enableTools and instructions');
  }
  if (typeof enableTools !== 'boolean' || typeof instructions !== 'string') throw fail('invalid tool mode or instructions');
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
        if (code !== 0) return reject(fail(`CLI exited with ${code ?? processSignal}: ${stderr.slice(0, 2000)}`));
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
      const state = { id: context.sessionId, directory, turns: 0, transcript: [], failed: false, executing: false, operation: undefined };
      sessions.set(context.sessionId, state);
      await writeFile(path.join(directory, 'orders.json'), JSON.stringify(initialState()));
      await writeFile(path.join(directory, 'audit.jsonl'), '');
      return { sessionId: context.sessionId, directory };
    },
    async verify(session, context) {
      context.signal.throwIfAborted();
      const state = sessionState(session, context);
      const info = await lstat(state.directory);
      const ok = state.turns === 0 && !info.isSymbolicLink() && info.isDirectory() &&
        await realpath(state.directory) === state.directory && (await readdir(state.directory)).sort().join(',') === 'audit.jsonl,orders.json' &&
        await readFile(path.join(state.directory, 'orders.json'), 'utf8') === JSON.stringify(initialState()) &&
        await readFile(path.join(state.directory, 'audit.jsonl'), 'utf8') === '';
      return { ok, evidence: 'Fresh owned temporary order database and empty tool audit. Each turn starts a new ephemeral CLI thread and replays only this trial transcript; the database persists within the trial. Remote hidden state is not independently verified.' };
    },
    async execute(messages, session, context) {
      context.signal.throwIfAborted();
      const state = sessionState(session, context);
      if (state.failed || state.executing) throw fail('failed or already-running conversation cannot be continued');
      if (!Array.isArray(messages) || messages.length !== state.transcript.length + 1 ||
        JSON.stringify(messages.slice(0, -1)) !== JSON.stringify(state.transcript) ||
        messages.at(-1)?.role !== 'user' || typeof messages.at(-1).content !== 'string') {
        throw fail('messages must extend only this trial transcript with one user message');
      }
      state.executing = true;
      state.turns++;
      const statePath = path.join(state.directory, 'orders.json'), auditPath = path.join(state.directory, 'audit.jsonl');
      const priorAudit = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const serverConfiguration = enableTools
        ? `{orders={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([serverPath, statePath, auditPath, String(state.turns)])},enabled=true,required=true,startup_timeout_sec=20,tool_timeout_sec=30,enabled_tools=${JSON.stringify(TOOL_NAMES)},default_tools_approval_mode="approve"}}`
        : '{}';
      const args = ['exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--cd', state.directory,
        '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"',
        '-c', 'approval_policy="never"', '-c', `mcp_servers=${serverConfiguration}`,
        ...DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
        ...(model ? ['--model', model] : []), '-'];
      const events = [];
      let threadId;
      let completed = 0;
      let finalOutput;
      let usage;
      const mcpCalls = [];
      const onLine = (line) => {
        let event;
        try { event = JSON.parse(line); } catch { throw fail('CLI stdout contained malformed JSONL'); }
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
          throw fail('CLI event must be an object with a type');
        }
        events.push(event);
        if (event.type === 'error' || event.type === 'turn.failed') throw fail(`CLI reported ${event.type}`);
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
          if (event.item?.type === 'mcp_tool_call') {
            if (completed || !['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
              throw fail('MCP item occurred outside the active turn');
            }
            if (!enableTools || event.item.server !== 'orders' || !TOOL_NAMES.includes(event.item.tool)) {
              throw fail('MCP call was outside the configured order tool allowlist');
            }
            if (event.type === 'item.completed') {
              if (event.item.error || event.item.status !== 'completed') throw fail('MCP tool transport failed');
              mcpCalls.push(event.item);
            }
            return;
          }
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
      const prompt = `${instructions}\n\nConversation transcript (user and assistant messages, in order):\n${JSON.stringify(messages)}\n\nRespond to the last user message. Do not repeat previous assistant turns.`;
      state.operation = start(args, { input: prompt, cwd: state.directory, signal: context.signal, onLine });
      try {
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
      const toolAudit = (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      if (!isDeepStrictEqual(toolAudit.slice(0, priorAudit.length), priorAudit)) throw fail('Earlier trial tool audit was changed');
      if (toolAudit.length - priorAudit.length !== mcpCalls.length) throw fail('CLI MCP events do not match the server tool audit count');
      const newAudit = toolAudit.slice(priorAudit.length);
      const unmatchedAudit = [...newAudit];
      for (const call of mcpCalls) {
        const index = unmatchedAudit.findIndex(audit => audit.turn === state.turns && audit.tool === call.tool &&
          isDeepStrictEqual(audit.args, call.arguments) && isDeepStrictEqual(audit.result, call.result?.structured_content));
        if (index < 0) throw fail('CLI MCP tool arguments or results do not match one-to-one with the current turn audit');
        unmatchedAudit.splice(index, 1);
      }
      const finalState = JSON.parse(await readFile(statePath, 'utf8'));
      state.transcript = [...structuredClone(messages), { role: 'assistant', content: finalOutput }];
      return { output: finalOutput, tokenUsage, metadata: { cliVersion: CLI_VERSION, threadId, usage, events,
        conversationStrategy: 'transcript-replay', eachTurnNewThread: true, trialDatabasePersists: true,
        turn: state.turns, toolsEnabled: enableTools, toolAudit, finalState,
        ...(model ? { requestedModel: model } : {}) } };
      } catch (error) { state.failed = true; throw error; }
      finally { state.executing = false; }
    },
    async cleanup(session, context) { await release(sessionState(session, context)); },
    async close() { for (const state of [...sessions.values()]) await release(state); },
  };
}
