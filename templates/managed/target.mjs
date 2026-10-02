// Replace every TODO with your service-specific lifecycle. No remote call is made here.
// Keep explicit ${ENV:NAME} references in config so formal admission covers these bindings.
// Do not return ok:true based only on a fresh UUID: verify remote memory AND business state.
function fromEnvironment(reference) {
  const match = typeof reference === 'string' && /^\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(reference);
  if (!match) throw new Error('Managed starter settings require explicit environment references');
  const value = process.env[match[1]];
  if (value === undefined || value === '') throw new Error(`Missing environment variable: ${match[1]}`);
  return value;
}

export function createTarget(config) {
  // Use these resolved settings in the implemented lifecycle. Never log apiKey.
  const service = { endpoint: fromEnvironment(config.endpoint), apiKey: fromEnvironment(config.apiKey) };
  return {
    async prepare(context) {
      context.signal.throwIfAborted();
      // TODO: use service.endpoint and service.apiKey for your existing service client.
      // TODO: create a remote conversation, isolated workspace/database fixture and idempotency namespace.
      // Bind every resource to context.sessionId and return the real remote identifiers.
      // Track partially created resources so a failed prepare can be recovered safely.
      throw new Error('TODO managed prepare: create and verify real isolated resources before allowing evaluation');
    },
    async verify(session, context) {
      context.signal.throwIfAborted();
      // TODO: query authoritative remote state and prove that prior-case messages, memory and mutations are absent.
      return { ok: false, evidence: 'TODO: remote conversation, persistent memory and business-state isolation have not been implemented or verified.' };
    },
    async execute(messages, session, context) {
      context.signal.throwIfAborted();
      // TODO: invoke the existing agent/workflow using only this case's messages and the bound remote identifiers.
      // Forward context.signal, disable hidden retries, and retain real tool/state evidence in metadata.
      throw new Error('TODO managed execute: connect the existing service after lifecycle verification');
    },
    async cleanup(session, context) {
      // TODO: release owned resources and verify deletion/reset; report partial failures.
      // Cleanup must still work after context.signal is aborted; use a separate bounded cleanup request if needed.
      throw new Error('TODO managed cleanup: release and verify all owned remote resources');
    },
    async recover(context) {
      // TODO: reconcile interrupted side effects and resources before explicitly enabling retries.
      return { ok: false, evidence: 'TODO: interrupted remote sessions and business effects require reconciliation.' };
    },
    async close() { /* No shared resources are created by this unimplemented scaffold. */ },
  };
}
