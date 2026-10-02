export const TOOL_NAMES = ['list_orders', 'get_order', 'refund_order', 'get_refund_status'];

export function initialState() {
  const definitions = [
    ['ORD-100', 'alex@example.test', 120, 'paid', true],
    ['ORD-101', 'alex@example.test', 75, 'delivered', true],
    ['ORD-102', 'alex@example.test', 60, 'delivered', false],
    ['ORD-103', 'sam@example.test', 90, 'refunded', true],
    ['ORD-104', 'sam@example.test', 45, 'paid', true],
    ['ORD-105', 'alex@example.test', 30, 'unpaid', true],
    ['ORD-106', 'sam@example.test', 80, 'shipped', true],
  ];
  return { version: 1, orders: Object.fromEntries(definitions.map(([orderId, customerEmail, amount, status, refundEligible]) =>
    [orderId, { orderId, customerEmail, amount, currency: 'USD', status, refundEligible,
      refundId: status === 'refunded' ? `RF-${orderId}` : null,
      refundCount: status === 'refunded' ? 1 : 0,
      refundReason: status === 'refunded' ? 'previous return' : null }])) };
}

export function applyTool(state, tool, args) {
  if (!TOOL_NAMES.includes(tool)) throw new Error('Unknown order tool');
  if (tool === 'list_orders') return { ok: true, orders: Object.values(state.orders).filter(order => order.customerEmail === args.customer_email) };
  const order = state.orders[args.order_id];
  if (!order) return { ok: false, code: 'not_found', orderId: args.order_id };
  if (tool === 'get_order') return { ok: true, order };
  if (tool === 'get_refund_status') return { ok: true, order, status: order.status === 'refunded' ? 'refunded' : 'not_refunded', refundId: order.refundId };
  if (order.status === 'refunded') return { ok: true, code: 'already_refunded', order };
  if (!['paid', 'delivered'].includes(order.status)) return { ok: false, code: 'invalid_status', order };
  if (!order.refundEligible) return { ok: false, code: 'not_eligible', reason: 'return_window_expired', order };
  if (typeof args.reason !== 'string' || !args.reason.trim()) return { ok: false, code: 'missing_reason', order };
  order.status = 'refunded'; order.refundId = `RF-${order.orderId}`;
  order.refundReason = args.reason; order.refundCount++;
  return { ok: true, code: 'refunded', order };
}
