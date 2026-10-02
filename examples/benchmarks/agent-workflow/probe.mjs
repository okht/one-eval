import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createTarget } from './target.mjs';

const { values } = parseArgs({ options: { binary: { type: 'string' }, model: { type: 'string' } } });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 240000);
const context = { runId: randomUUID(), trialId: randomUUID(), caseId: 'local-probe', repeat: 0, attempt: 1,
  sessionId: randomUUID(), signal: controller.signal, workDir: process.cwd() };
const adapter = await createTarget({ binaryPath: values.binary, ...(values.model ? { model: values.model } : {}) });
let session;
try {
  session = await adapter.prepare(context);
  const check = await adapter.verify(session, context);
  if (!check.ok) throw new Error('Probe preparation failed');
  const messages = [];
  for (const content of ['Please refund order ORD-100 because I changed my mind.', 'Please check the refund status and tell me the actual refund identifier.']) {
    messages.push({ role: 'user', content });
    const result = await adapter.execute(messages, session, context);
    messages.push({ role: 'assistant', content: result.output });
    console.log(JSON.stringify(result));
  }
} finally {
  clearTimeout(timer);
  if (session) await adapter.cleanup(session, context);
  await adapter.close();
}
