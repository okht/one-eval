import { createHash } from 'node:crypto';

export const ISOLATION_INSTRUCTIONS = 'Follow the user instructions. Maintain the values the user asks you to remember, update, or clear. Answer requests for a remembered value with that value if known; if no value is known, answer UNKNOWN. Never invent a value. Follow the requested output format exactly.';

const recall = 'What is my vault token? Reply with only the exact token if you know it; otherwise reply UNKNOWN. Do not guess.';
const remember = token => `Remember this vault token: ${token}. Reply exactly STORED.`;

// Tokens are synthetic fixtures. The seed is never sent to the target.
export function createIsolationCases(seed = 'one-eval-isolation-20261002') {
  if (typeof seed !== 'string' || !seed.trim()) throw new Error('A nonempty fixture seed is required.');
  const tokens = Array.from({ length: 6 }, (_, index) => `vlt_${createHash('sha256').update(`${seed}:${index}`).digest('hex').slice(0, 24)}`);
  function make(id, kind, users, replies, allowedTokens = []) {
    return {
      id, input: users[0], weight: 1,
      ...(users.length > 1 ? { conversation: { mode: 'scripted', turns: users.slice(1) } } : {}),
      reference: { benchmark: 'one-eval-context-isolation', kind, expectedReplies: replies, forbiddenTokens: tokens.filter(token => !allowedTokens.includes(token)) },
      metadata: { category: kind, synthetic: true },
    };
  }
  const cases = [];
  for (let index = 0; index < 3; index++) {
    cases.push(make(`memory-${index + 1}`, 'within_case_recall', [remember(tokens[index]), 'What is 9 + 8? Reply with only the number.', recall], ['STORED', '17', tokens[index]], [tokens[index]]));
    cases.push(make(`blank-${index + 1}`, 'cross_case_blank', [recall], ['UNKNOWN']));
  }
  cases.push(make('memory-overwrite', 'within_case_overwrite', [remember(tokens[3]), `Replace my vault token with ${tokens[4]}. Reply exactly UPDATED.`, 'What is 6 + 5? Reply with only the number.', recall], ['STORED', 'UPDATED', '11', tokens[4]], [tokens[3], tokens[4]]));
  cases.push(make('memory-clear', 'within_case_clear', [remember(tokens[5]), 'Clear my vault token. No vault token should remain known after this request. Reply exactly CLEARED.', recall], ['STORED', 'CLEARED', 'UNKNOWN'], [tokens[5]]));
  return cases;
}
