// Deterministic plumbing fixture. Its scores do not measure model intelligence.
export function createTarget() {
  const sessions = new Map();
  const stateFor = (session, context) => {
    const state = sessions.get(session?.id);
    if (!state || session.id !== context.sessionId) throw new Error('Unknown or mismatched fixture session');
    return state;
  };
  return {
    async prepare(context) {
      context.signal.throwIfAborted();
      if (sessions.has(context.sessionId)) throw new Error('Session ID was reused');
      sessions.set(context.sessionId, { calls: 0 });
      return { id: context.sessionId };
    },
    async verify(session, context) {
      const state = stateFor(session, context);
      return { ok: state.calls === 0, evidence: 'A fresh in-memory fixture store exists for this runner session and has handled no messages.' };
    },
    async execute(messages, session, context) {
      context.signal.throwIfAborted();
      const state = stateFor(session, context);
      const message = messages.at(-1);
      if (message?.role !== 'user' || !message.content.startsWith('Echo exactly: ')) throw new Error('This fixture only supports inputs beginning with Echo exactly: ');
      state.calls++;
      return { output: message.content.slice('Echo exactly: '.length), metadata: { sessionId: session.id, turn: state.calls } };
    },
    async cleanup(session, context) { stateFor(session, context); sessions.delete(session.id); },
    async recover() { return { ok: sessions.size === 0, evidence: 'Only fixture memory is managed; no network calls or external business state exist.' }; },
    async close() { if (sessions.size) throw new Error('Fixture sessions remain active after cleanup'); },
  };
}
