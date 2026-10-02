import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyError, sanitizeDiagnosticMessage } from '../src/diagnostics.js';

test('diagnostics preserve underlying status and codes through bounded cause chains', () => {
  const error = new Error('Provider request failed', { cause: Object.assign(new Error('Please retry later'), { code: 'provider_quota', status: 429 }) });
  const result = classifyError(error, 'grading');
  assert.equal(result.code, 'rate_limit');
  assert.equal(result.retryable, true);
  assert.equal(result.causeCode, 'provider_quota');
  assert.equal(result.statusCode, 429);
  assert.deepEqual(result.causes, [{ message: 'Please retry later', code: 'provider_quota', statusCode: 429 }]);
  const cyclic = new Error('Cyclic cause');
  cyclic.cause = cyclic;
  assert.equal(classifyError(cyclic, 'execution').causes, undefined);
});

test('diagnostics redact common secrets without removing actionable error context', () => {
  const message = 'HTTP 401 api_key=key-value password="hunter2" Authorization: Bearer bearer-secret ' +
    'https://name:passwd@example.test/?access_token=token-value&retry=0 {"client_secret":"secret-value"} sk-proj-Abc123456789';
  const result = classifyError(new Error(message), 'execution');
  assert.equal(result.code, 'authentication');
  assert.equal(result.retryable, false);
  for (const secret of ['key-value', 'hunter2', 'bearer-secret', 'name:passwd', 'token-value', 'secret-value', 'sk-proj-Abc123456789']) {
    assert.ok(!JSON.stringify(result).includes(secret), `Leaked ${secret}`);
  }
  assert.match(result.message, /HTTP 401/);
  assert.match(result.message, /example\.test/);
  assert.ok(sanitizeDiagnosticMessage('x'.repeat(6000)).length < 4100);
  assert.equal(sanitizeDiagnosticMessage('password="a secret with spaces" remains actionable'), 'password=[REDACTED] remains actionable');
});

test('diagnostic retry advice remains conservative and does not flatten process failures', () => {
  assert.equal(classifyError(Object.assign(new Error('connect failed'), { code: 'ECONNRESET' }), 'execute').retryable, true);
  assert.equal(classifyError(new Error('Grader exceeded 20 ms'), 'grading').code, 'timeout');
  assert.equal(classifyError(new Error('Trial deadline exceeded; remote outcome may be unknown'), 'execute').code, 'timeout');
  assert.equal(classifyError(Object.assign(new Error('Unknown remote outcome'), { code: 'INTERRUPTED' }), 'grading.recovery').retryable, false);
  assert.equal(classifyError(new Error('Grader exited with 2'), 'grading').code, 'process_exit');
  assert.equal(classifyError(new Error('Grader exited with 2'), 'grading').retryable, false);
  assert.equal(classifyError(new Error('Unexpected failure'), 'execution.cleanup').code, 'cleanup_failed');
  assert.equal(classifyError(new Error('Grader stdout must contain exactly one JSON value'), 'grading').code, 'invalid_output');
  assert.equal(classifyError(new Error('Missing environment variable: API_TOKEN'), 'grading').code, 'configuration');
  assert.equal(classifyError(new Error('Odd failure'), 'grading').retryable, false);
});

test('capacity and temporary service errors recommend explicit retry without inventing a model fallback', () => {
  for (const error of [
    new Error('Selected model is at capacity. Please try a different model.'),
    new Error('The service is overloaded'),
    ...[502, 503, 504].map((status) => Object.assign(new Error('Provider failed'), { status })),
  ]) {
    const diagnostic = classifyError(error, 'grading.provider');
    assert.equal(diagnostic.code, 'service_unavailable');
    assert.equal(diagnostic.retryable, true);
  }
});

test('adversarial: diagnostics never throw when providers throw unusual objects or poisoned getters', () => {
  const bare = Object.assign(Object.create(null), { code: 'ECONNRESET' });
  const poisoned = Object.defineProperties({}, { message: { get() { throw new Error('getter failed'); } }, cause: { get() { throw new Error('cause getter failed'); } } });
  assert.equal(classifyError(bare, 'grading.provider').code, 'network');
  assert.equal(classifyError(poisoned, 'grading.provider').code, 'unknown');
});
