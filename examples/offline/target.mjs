import { appendFile } from 'node:fs/promises';

if (process.env.ONE_EVAL_EXAMPLE_TARGET_DISABLED === '1') {
  throw new Error('The offline target is disabled. Judging must not import it.');
}

// This fixture represents a stateful local application. No API or external business system is used.
export function createTarget(config = {}) {
  const sessions = new Map();
  function getSession(session, context) {
    context.signal.throwIfAborted();
    const state = sessions.get(session?.id);
    if (!state || session.id !== context.sessionId || state.caseId !== context.caseId) {
      throw new Error('Unknown or mismatched session.');
    }
    return state;
  }
  return {
    async prepare(context) {
      context.signal.throwIfAborted();
      if (sessions.has(context.sessionId)) throw new Error('Session ID was reused.');
      sessions.set(context.sessionId, { caseId: context.caseId, turns: 0, budget: null, orderStatus: 'paid' });
      return { id: context.sessionId };
    },
    async verify(session, context) {
      const state = getSession(session, context);
      return { ok: state.turns === 0 && state.budget === null && state.orderStatus === 'paid',
        evidence: `Fresh in-memory state for session ${session.id}.` };
    },
    async execute(messages, session, context) {
      const state = getSession(session, context);
      if (messages.filter((message) => message.role === 'assistant').length !== state.turns) {
        throw new Error('Conversation history does not belong to this attempt.');
      }
      state.turns++;
      if (config.callLog) await appendFile(config.callLog, `${JSON.stringify({ caseId: context.caseId, sessionId: context.sessionId, turn: state.turns })}\n`);
      const input = messages.filter((message) => message.role === 'user').at(-1)?.content ?? '';
      const budget = input.match(/budget is (\d+)/i);
      if (budget) state.budget = budget[1];
      let output;
      if (/refund|wrong size/i.test(input)) {
        if (/wrong size/i.test(input)) {
          state.orderStatus = 'refunded';
          output = 'Order order-123 has been refunded.';
        } else output = 'What is the reason for your refund request?';
      } else output = state.budget === null ? 'No budget has been supplied.' : `Your budget is ${state.budget}.`;
      return { output, metadata: { sessionId: session.id, turns: state.turns, orderStatus: state.orderStatus } };
    },
    async cleanup(session) { if (session?.id) sessions.delete(session.id); },
    async recover() { sessions.clear(); return { ok: true, evidence: 'All fixture sessions were cleared.' }; },
    async close() { sessions.clear(); },
  };
}
