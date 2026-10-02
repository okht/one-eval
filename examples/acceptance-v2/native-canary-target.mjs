import { createHash } from 'node:crypto';
import { createTarget as createNativeTarget } from '../acceptance/native-http-target.mjs';

export function canaryFor(context) {
  return `CANARY_${createHash('sha256').update(JSON.stringify([context.runId, context.trialId, context.repeat, context.attempt, context.sessionId])).digest('hex').slice(0, 20)}`;
}

export async function createTarget(config, dependencies = {}) {
  const inner = await (dependencies.createNativeTarget ?? createNativeTarget)(config);
  const seen = new Set();
  return {
    async prepare(context) {
      const session = await inner.prepare(context);
      const canary = canaryFor(context);
      if (seen.has(canary)) throw new Error('Acceptance canary was reused');
      seen.add(canary);
      return { ...session, canary };
    },
    async verify(session, context) {
      const check = await inner.verify(session, context);
      return { ok: check.ok && session.canary === canaryFor(context), evidence: `${check.evidence}; unique per-attempt isolation canary assigned without disclosing it to blank probes` };
    },
    async execute(messages, session, context) {
      if (session.canary !== canaryFor(context)) throw new Error('Canary/session identity mismatch');
      const substituted = messages.map(message => ({ ...message, content: message.content.replaceAll('__TRIAL_SECRET__', session.canary).replaceAll('__TRIAL_UPDATE__', `${session.canary}_UPDATED`) }));
      const result = await inner.execute(substituted, session, context);
      return { ...result, metadata: { ...result.metadata, canary: session.canary, transportInput: substituted.at(-1).content, userInputWasSubstituted: messages.at(-1).content !== substituted.at(-1).content } };
    },
    async cleanup(session, context) { await inner.cleanup(session, context); },
    async close() { await inner.close(); },
  };
}
