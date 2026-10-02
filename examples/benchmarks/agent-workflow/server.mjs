import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyTool, TOOL_NAMES } from './fixture.mjs';

export function createOrderServer({ statePath, auditPath, turn = 1 }) {
  if (!path.isAbsolute(statePath) || !path.isAbsolute(auditPath) || path.dirname(statePath) !== path.dirname(auditPath)) {
    throw new Error('The fixture requires absolute state/audit paths in one owned trial directory');
  }
  const server = new McpServer({ name: 'one-eval-orders', version: '1.0.0' });
  let queue = Promise.resolve();
  const specifications = {
    list_orders: { description: 'List orders belonging to an exact customer email. Use when an order ID is missing.',
      inputSchema: z.object({ customer_email: z.string().min(1) }).strict() },
    get_order: { description: 'Read a specific order, its status, amount and refund eligibility before taking action.',
      inputSchema: z.object({ order_id: z.string().min(1) }).strict() },
    refund_order: { description: 'Refund a paid or delivered eligible order after the user explicitly requests a refund and provides a reason. Never use for a query-only request. Already-refunded orders are idempotent; unpaid/shipped/ineligible orders cannot be refunded.',
      inputSchema: z.object({ order_id: z.string().min(1), reason: z.string().trim().min(1) }).strict() },
    get_refund_status: { description: 'Read the actual refund status and identifier for an order.',
      inputSchema: z.object({ order_id: z.string().min(1) }).strict() },
  };
  for (const tool of TOOL_NAMES) server.registerTool(tool, {
    ...specifications[tool],
    annotations: { readOnlyHint: tool !== 'refund_order', destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (args) => {
    const operation = queue.then(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      if (state.version !== 1 || !state.orders) throw new Error('Invalid fixture state');
      const result = structuredClone(applyTool(state, tool, args));
      const temporary = `${statePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state));
      await rename(temporary, statePath);
      const auditText = await readFile(auditPath, 'utf8');
      const sequence = auditText.trim() ? auditText.trim().split('\n').length + 1 : 1;
      await appendFile(auditPath, `${JSON.stringify({ sequence, turn, tool, args, result })}\n`);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    });
    queue = operation.catch(() => {});
    return operation;
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [statePath, auditPath, turnValue] = process.argv.slice(2);
  const server = createOrderServer({ statePath, auditPath, turn: Number(turnValue ?? 1) });
  await server.connect(new StdioServerTransport());
}
