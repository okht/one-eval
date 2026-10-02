export default class FixtureProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.calls = 0;
  }

  id() { return 'adapters-fixture'; }

  async callApi(prompt, context, options) {
    options?.abortSignal?.throwIfAborted();
    if (this.config.responses) {
      const next = this.config.responses[this.calls++];
      return {
        output: typeof next === 'string' ? next : JSON.stringify(next),
        metadata: { request: JSON.parse(prompt), sawSignal: Boolean(options?.abortSignal) },
        cost: 0.01,
        tokenUsage: { prompt: 2, completion: 3, total: 5 },
      };
    }
    if (this.config.error) return { error: this.config.error };
    return {
      output: this.config.empty ? '' : prompt,
      metadata: { context: context.vars, sawSignal: Boolean(options?.abortSignal) },
    };
  }
}
