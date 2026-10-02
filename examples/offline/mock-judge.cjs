// This fixture tests the model-provider grading path, not model judgment quality.
module.exports = class OfflineJudge {
  id() { return 'offline-model-judge'; }
  async callApi() {
    return { output: JSON.stringify({ status: 'scored', score: 1, reason: 'Deterministic protocol fixture; this is not an independent quality assessment.' }) };
  }
};
