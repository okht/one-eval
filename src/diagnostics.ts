export type DiagnosticCode = 'authentication' | 'permission_denied' | 'rate_limit' | 'service_unavailable' | 'timeout' |
  'network' | 'configuration' | 'invalid_output' | 'output_limit' | 'process_exit' | 'cleanup_failed' | 'interrupted' | 'unknown';

export interface DiagnosticCause { message: string; code?: string; statusCode?: number }
export interface Diagnostic {
  code: DiagnosticCode;
  phase: string;
  message: string;
  /** A recommendation only. The caller's explicit retry and side-effect policy still applies. */
  retryable: boolean;
  causeCode?: string;
  statusCode?: number;
  causes?: DiagnosticCause[];
}

const MAX_MESSAGE = 4000;

/** Best-effort protection for common credentials in provider and process error messages. */
export function sanitizeDiagnosticMessage(value: string): string {
  const sanitized = value
    .replace(/(\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?)(?:Bearer|Basic)\s+[^\s,"';]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,"';&}]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return sanitized.length > MAX_MESSAGE ? `${sanitized.slice(0, MAX_MESSAGE)} [truncated]` : sanitized;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function field(value: unknown, key: string): unknown {
  try { return object(value)?.[key]; } catch { return undefined; }
}

function printable(value: unknown): string {
  try { return String(value); } catch { return 'Unprintable provider error'; }
}

function describe(error: unknown): DiagnosticCause {
  const message = field(error, 'message');
  const rawMessage = typeof message === 'string' ? message : printable(error);
  const rawCode = field(error, 'code');
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? String(rawCode) : undefined;
  const status = field(error, 'statusCode') ?? field(error, 'status') ?? field(field(error, 'response'), 'status');
  return {
    message: sanitizeDiagnosticMessage(rawMessage),
    ...(code === undefined ? {} : { code: sanitizeDiagnosticMessage(code).slice(0, 100) }),
    ...(typeof status === 'number' && Number.isInteger(status) ? { statusCode: status } : {}),
  };
}

export function classifyError(error: unknown, phase: string): Diagnostic {
  const chain: DiagnosticCause[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    chain.push(describe(current));
    current = field(current, 'cause');
  }
  if (!chain.length) chain.push(describe(error));
  const message = chain[0]!.message;
  const all = chain.map((item) => `${item.code ?? ''} ${item.message}`).join('\n');
  const statuses = chain.flatMap((item) => item.statusCode === undefined ? [] : [item.statusCode]);
  const statusCode = statuses[0];
  const causeCode = chain.find((item) => item.code !== undefined)?.code;
  let code: DiagnosticCode = 'unknown';
  if (statuses.includes(401) || /\b401\b|unauthorized|authentication|invalid[_ -]?api[_ -]?key/i.test(all)) code = 'authentication';
  else if (statuses.includes(403) || /\b403\b|forbidden|permission denied|\bEACCES\b|\bEPERM\b/i.test(all)) code = 'permission_denied';
  else if (/cleanup/i.test(phase) || /\bCLEANUP_FAILED\b|cleanup failed|cleanup timed out/i.test(all)) code = 'cleanup_failed';
  else if (statuses.includes(429) || /\b429\b|rate[_ -]?limit|too many requests/i.test(all)) code = 'rate_limit';
  else if (statuses.some((status) => [502, 503, 504].includes(status)) || /\b(?:502|503|504)\b|overload(?:ed)?|at capacity|service unavailable|bad gateway/i.test(all)) code = 'service_unavailable';
  else if (/\bETIMEDOUT\b|\bTIMEOUT\b|timed?\s*out|deadline exceeded|exceeded \d+ ms/i.test(all)) code = 'timeout';
  else if (/\bINTERRUPTED\b/i.test(all)) code = 'interrupted';
  else if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)\b|fetch failed|network error|socket hang up/i.test(all)) code = 'network';
  else if (/\bOUTPUT_LIMIT\b|exceeded (?:the )?(?:\d+ MiB |output )?limit/i.test(all)) code = 'output_limit';
  else if (/\bINVALID_OUTPUT\b|invalid grader|grader score|grader reason|grader status|unscored grader|grader must return|stdout must contain|malformed JSON/i.test(all)) code = 'invalid_output';
  else if (/\b(?:ENOENT|CONFIGURATION)\b|missing .*environment variable|has no (?:provider|executable)|configuration/i.test(all)) code = 'configuration';
  else if (/\bPROCESS_EXIT\b|exited with|exit code/i.test(all)) code = 'process_exit';
  return {
    code, phase, message, retryable: ['rate_limit', 'service_unavailable', 'timeout', 'network'].includes(code),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(chain.length > 1 ? { causes: chain.slice(1) } : {}),
  };
}
