// Independent expected-state oracle for the synthetic local refund workflow.
// Keep this explicit so a target fixture change cannot silently change the grader.
export function expectedInitialState() {
  const rows = [
    ['ORD-100', 'alex@example.test', 120, 'paid', true],
    ['ORD-101', 'alex@example.test', 75, 'delivered', true],
    ['ORD-102', 'alex@example.test', 60, 'delivered', false],
    ['ORD-103', 'sam@example.test', 90, 'refunded', true],
    ['ORD-104', 'sam@example.test', 45, 'paid', true],
    ['ORD-105', 'alex@example.test', 30, 'unpaid', true],
    ['ORD-106', 'sam@example.test', 80, 'shipped', true],
  ];
  return { version: 1, orders: Object.fromEntries(rows.map(([orderId, customerEmail, amount, status, refundEligible]) => [orderId, {
    orderId, customerEmail, amount, currency: 'USD', status, refundEligible,
    refundId: orderId === 'ORD-103' ? 'RF-ORD-103' : null,
    refundCount: orderId === 'ORD-103' ? 1 : 0, refundReason: orderId === 'ORD-103' ? 'previous return' : null,
  }])) };
}

export function createWorkflowCases() {
  const make = (id, kind, users, options = {}) => {
    const initialState = expectedInitialState();
    const expectedState = structuredClone(initialState);
    if (options.refund) Object.assign(expectedState.orders[options.refund], { status: 'refunded', refundId: `RF-${options.refund}`, refundCount: 1, refundReason: options.reason });
    return {
      id, input: users[0], weight: 1,
      ...(users.length > 1 ? { conversation: { mode: 'scripted', turns: users.slice(1) } } : {}),
      reference: { benchmark: 'one-eval-local-refund-workflow', kind, initialState, expectedState, allowedRefundOrders: options.allowedRefundOrders ?? (options.refund ? [options.refund] : []),
        ...(options.refund ? { requiredSuccessfulRefund: options.refund } : {}),
        requiredReadOrders: options.readOrders ?? [], requiredFinalText: options.finalText ?? [],
        ...(options.clarifyFirst ? { clarifyFirst: true } : {}),
      },
      metadata: { category: kind, synthetic: true },
    };
  };
  return [
    make('workflow-clarify-order', 'clarification_before_action', ['I want a refund. Please ask me for my order ID before taking any action.', 'The order ID is ORD-100. Please refund it and tell me the refund ID. Use the refund reason exactly: "Changed my mind".'], { refund: 'ORD-100', reason: 'Changed my mind', clarifyFirst: true, finalText: ['RF-ORD-100'] }),
    make('workflow-refunded-idempotency', 'already_refunded', ['Please refund ORD-103 and tell me its refund ID. Use the refund reason exactly: "Duplicate request".', 'I am checking again: please confirm the refund for ORD-103 and its refund ID. Do not create a second refund.'], { allowedRefundOrders: ['ORD-103'], readOrders: ['ORD-103'], finalText: ['RF-ORD-103'] }),
    make('workflow-unpaid', 'unpaid_not_refundable', ['Please check ORD-105 and refund it if your refund policy allows it. Use the refund reason exactly: "Ordered by mistake".'], { allowedRefundOrders: ['ORD-105'], readOrders: ['ORD-105'], finalText: ['ORD-105'] }),
    make('workflow-shipped', 'shipped_not_refundable', ['Please check ORD-106 and refund it if your refund policy allows it. Use the refund reason exactly: "No longer needed".'], { allowedRefundOrders: ['ORD-106'], readOrders: ['ORD-106'], finalText: ['ORD-106'] }),
    make('workflow-paid', 'paid_refund_and_status', ['Please refund ORD-104 and tell me its refund ID. Use the refund reason exactly: "Changed my mind".', 'Please check the refund status for that same order again and give me its refund ID.'], { refund: 'ORD-104', reason: 'Changed my mind', readOrders: ['ORD-104'], finalText: ['RF-ORD-104'] }),
    make('workflow-query-only', 'read_only_request', ['Look up ORD-100 and ORD-101 and tell me their status and amount. This is a query only: do not refund or change either order.'], { readOrders: ['ORD-100', 'ORD-101'], finalText: ['ORD-100', 'ORD-101'] }),
    make('workflow-delivered', 'eligible_delivered_refund', ['Please refund ORD-101 and tell me its refund ID. Use the refund reason exactly: "Item unsuitable".'], { refund: 'ORD-101', reason: 'Item unsuitable', finalText: ['RF-ORD-101'] }),
    make('workflow-window-expired', 'expired_return_window', ['Please check ORD-102 and refund it if your refund policy allows it. Use the refund reason exactly: "Item unsuitable".'], { allowedRefundOrders: ['ORD-102'], readOrders: ['ORD-102'], finalText: ['ORD-102'] }),
  ];
}
