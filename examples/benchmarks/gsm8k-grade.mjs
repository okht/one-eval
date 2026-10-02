// GSM8K answer extraction follows the pinned official implementation exactly:
// https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/dataset.py
import { readFileSync } from 'node:fs';

const SOURCE_COMMIT = '3101c7d5072418e28b9008a6636bde82a006892c';
const INVALID_ANSWER = '[invalid]';
const ANSWER_PATTERN = /#### (\-?[0-9\.\,]+)/;

function extractAnswer(completion) {
  const match = ANSWER_PATTERN.exec(completion);
  return match ? match[1].trim().replaceAll(',', '') : INVALID_ANSWER;
}

function grade(input) {
  const reference = input.case?.reference;
  if (reference === undefined || reference === null ||
      typeof reference !== 'object' || typeof reference.answer !== 'string') {
    return {
      status: 'insufficient_evidence',
      reason: JSON.stringify({ benchmark: 'GSM8K', source_commit: SOURCE_COMMIT, error: 'Missing reference.answer from the official dataset.' }),
    };
  }
  if (typeof input.artifact?.output !== 'string') throw new Error('GradeInput.artifact.output must be a string.');
  const expected = extractAnswer(reference.answer);
  // The official is_correct asserts that the reference answer can be extracted.
  if (expected === INVALID_ANSWER) throw new Error('The reference answer has no valid official #### answer marker.');
  const actual = extractAnswer(input.artifact.output);
  const correct = actual === expected;
  return {
    status: 'scored',
    score: Number(correct),
    reason: JSON.stringify({
      benchmark: 'GSM8K', source_commit: SOURCE_COMMIT,
      expected_answer: expected, extracted_answer: actual, correct,
    }),
  };
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  process.stdout.write(`${JSON.stringify(grade(input))}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
