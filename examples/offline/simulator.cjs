// Promptfoo custom provider. A deterministic stand-in for a simulated-user model.
module.exports = class OfflineSimulator {
  id() { return 'offline-user-simulator'; }
  async callApi(prompt) {
    const action = prompt.includes('Order order-123 has been refunded.')
      ? { action: 'stop', reason: 'The refund was confirmed.' }
      : { action: 'message', content: 'The item is the wrong size.' };
    return { output: JSON.stringify(action) };
  }
};
