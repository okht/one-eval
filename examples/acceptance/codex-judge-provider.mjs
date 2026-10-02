import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { invokeCodex } from './codex-run.mjs';

export default class CodexJudgeProvider {
  constructor(options) { this.config = options.config; }
  id() { return `one-eval-acceptance:${this.config.model}`; }
  async callApi(prompt, _context, options) {
    const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-judge-acceptance-'));
    try {
      const messages = JSON.parse(prompt);
      const input = messages.map(message => `${message.role.toUpperCase()}\n${message.content}`).join('\n\n');
      const result = await invokeCodex({ ...this.config, prompt: input, cwd: directory, signal: options?.abortSignal, ephemeral: true });
      return { output: result.output, tokenUsage: { total: result.usage.input_tokens + result.usage.output_tokens, prompt: result.usage.input_tokens, completion: result.usage.output_tokens, cached: result.usage.cached_input_tokens },
        metadata: { callId: result.callId, threadId: result.threadId, requestedModel: result.requestedModel, cliVersion: result.cliVersion, usage: result.usage } };
    } finally { await rm(directory, { recursive: true, force: false }); }
  }
}
