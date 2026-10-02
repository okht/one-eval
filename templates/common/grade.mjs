import fs from 'node:fs';

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
if (typeof input.case.reference !== 'string') {
  console.log(JSON.stringify({ status: 'insufficient_evidence', reason: 'Exact-match grading requires a string reference supplied by the dataset owner.' }));
} else {
  const equal = input.artifact.output === input.case.reference;
  console.log(JSON.stringify({ status: 'scored', score: equal ? 1 : 0, reason: equal ? 'The output exactly matches the supplied reference.' : 'The output differs from the supplied reference; whitespace and punctuation count.' }));
}
