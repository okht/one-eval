export function createTarget(config) {
  const sessions = new Map();
  return {
    async prepare(context) {
      context.signal.throwIfAborted();
      if (sessions.has(context.sessionId)) throw new Error('Session already exists');
      sessions.set(context.sessionId, []);
      return { sessionId: context.sessionId };
    },
    async verify(session, context) {
      return {
        ok: session.sessionId === context.sessionId && sessions.has(session.sessionId),
        evidence: 'An independent in-memory test session was created',
      };
    },
    async execute(messages, session, context) {
      context.signal.throwIfAborted();
      const history = sessions.get(session.sessionId);
      if (!history) throw new Error('Unknown session');
      history.push(messages.at(-1).content);
      return { output: JSON.stringify(history), metadata: { label: config.label ?? 'fixture' } };
    },
    async cleanup(session) { sessions.delete(session.sessionId); },
    async close() { sessions.clear(); },
  };
}
