import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invokeCodex } from './codex-run.mjs';

// A loopback application owns conversation sessions. Only the latest user turn
// crosses the HTTP boundary; Codex native resume supplies prior context.
export async function startNativeService(config, dependencies = {}) {
  const invoke = dependencies.invoke ?? invokeCodex;
  const sessions = new Map();
  const threads = new Set();
  const root = await realpath(tmpdir());
  const auditFile = path.resolve(config.auditFile);
  await mkdir(path.dirname(auditFile), { recursive: true });
  const audit = event => appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  async function release(state) {
    if (state.busy) throw new Error('Session has an active native call');
    if (path.dirname(state.directory) !== root || !path.basename(state.directory).startsWith('one-eval-native-http-')) throw new Error('Cleanup path is outside owned temporary root');
    const info = await lstat(state.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(state.directory) !== state.directory) throw new Error('Cleanup directory identity changed');
    await rm(state.directory, { recursive: true, force: false });
    sessions.delete(state.id);
    await audit({ type: 'session.deleted', sessionId: state.id, threadId: state.threadId ?? null, turns: state.turns, directoryRemoved: true, nativeHistory: 'Retained by Codex for audit; service capability revoked' });
  }
  const server = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      const parts = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
      if (request.method === 'POST' && parts.length === 1 && parts[0] === 'sessions') {
        const id = randomUUID(), directory = await mkdtemp(path.join(root, 'one-eval-native-http-'));
        const state = { id, directory, turns: 0, threadId: undefined, busy: false };
        sessions.set(id, state);
        await audit({ type: 'session.created', sessionId: id, directory });
        return send(201, { sessionId: id });
      }
      const state = parts[0] === 'sessions' ? sessions.get(parts[1]) : undefined;
      if (!state) return send(404, { error: 'Unknown or closed session' });
      if (request.method === 'GET' && parts.length === 2) {
        const emptyDirectory = (await readdir(state.directory)).length === 0;
        return send(200, { sessionId: state.id, turns: state.turns, threadId: state.threadId ?? null, busy: state.busy, emptyDirectory });
      }
      if (request.method === 'DELETE' && parts.length === 2) {
        await release(state); return send(200, { deleted: true, sessionId: state.id, directoryRemoved: true });
      }
      if (request.method !== 'POST' || parts[2] !== 'turns' || parts.length !== 3) return send(405, { error: 'Unsupported request' });
      if (state.busy) return send(409, { error: 'Concurrent turn on same session' });
      let body = '';
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) return send(413, { error: 'Request too large' }); }
      const parsed = JSON.parse(body);
      if (Object.keys(parsed).length !== 1 || typeof parsed.message !== 'string') return send(400, { error: 'Expected only the latest message' });
      state.busy = true;
      const abort = new AbortController();
      const disconnected = () => { if (!response.writableEnded) abort.abort(); };
      response.once('close', disconnected);
      try {
        const prompt = state.turns === 0 ? `This is a disposable conversation-memory test. Use only this conversation. Do not use tools. If no value has been stored in this conversation, answer UNKNOWN. Follow exact requested output formatting.\n\n${parsed.message}` : parsed.message;
        const result = await invoke({ binaryPath: config.binaryPath, model: config.model, prompt, cwd: state.directory, threadId: state.threadId, ephemeral: false, evidenceDir: config.evidenceDir, maxCalls: config.maxCalls ?? 90, timeoutMs: 60000, signal: abort.signal });
        if (!state.threadId) {
          if (threads.has(result.threadId)) throw new Error('Native thread reused across service sessions');
          threads.add(result.threadId); state.threadId = result.threadId;
        }
        state.turns++;
        await audit({ type: 'turn.completed', sessionId: state.id, threadId: state.threadId, turn: state.turns, callId: result.callId, transport: 'latest_message_only', nativeResume: state.turns > 1 });
        return send(200, { output: result.output, tokenUsage: { input: result.usage.input_tokens, output: result.usage.output_tokens, cached: result.usage.cached_input_tokens },
          metadata: { serviceSessionId: state.id, nativeThreadId: state.threadId, nativeResume: state.turns > 1, turn: state.turns, callId: result.callId, requestedModel: result.requestedModel, transport: 'latest_message_only' } });
      } catch (error) { await audit({ type: 'turn.error', sessionId: state.id, turn: state.turns + 1, error: error.message }); throw error; }
      finally { state.busy = false; response.removeListener('close', disconnected); }
    } catch (error) { send(500, { error: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, async close() {
    for (const state of [...sessions.values()]) await release(state);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await audit({ type: 'service.closed', activeSessions: sessions.size });
  } };
}

export async function createTarget(config) {
  const service = await startNativeService(config);
  const sessions = new Map();
  async function request(method, suffix, body, signal) {
    const response = await fetch(`${service.url}${suffix}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    const value = await response.json(); if (!response.ok) throw new Error(`Stateful HTTP ${response.status}: ${value.error}`); return value;
  }
  return {
    async prepare(context) {
      const created = await request('POST', '/sessions', undefined, context.signal);
      sessions.set(context.sessionId, { serviceId: created.sessionId, turns: 0 });
      return { trialSessionId: context.sessionId, serviceId: created.sessionId };
    },
    async verify(session, context) {
      if (session.trialSessionId !== context.sessionId) throw new Error('Trial session identity mismatch');
      const state = await request('GET', `/sessions/${session.serviceId}`, undefined, context.signal);
      return { ok: state.turns === 0 && state.threadId === null && !state.busy && state.emptyDirectory, evidence: `Fresh server-owned HTTP session ${session.serviceId}; no native thread or stored turns; empty owned working directory` };
    },
    async execute(messages, session, context) {
      const state = sessions.get(context.sessionId);
      if (!state || state.serviceId !== session.serviceId || messages.length !== state.turns * 2 + 1 || messages.at(-1)?.role !== 'user') throw new Error('Unexpected trial conversation progression');
      const response = await request('POST', `/sessions/${session.serviceId}/turns`, { message: messages.at(-1).content }, context.signal);
      state.turns++;
      return response;
    },
    async cleanup(session, context) {
      const result = await request('DELETE', `/sessions/${session.serviceId}`);
      const check = await fetch(`${service.url}/sessions/${session.serviceId}`);
      if (!result.deleted || !result.directoryRemoved || check.status !== 404) throw new Error('Service cleanup verification failed');
      sessions.delete(context.sessionId);
    },
    async close() { await service.close(); },
  };
}
