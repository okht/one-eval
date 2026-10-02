let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
const expected = input.case.reference?.contains;
if (typeof expected !== 'string') {
  process.stdout.write(JSON.stringify({ status: 'insufficient_evidence', reason: 'This fixture requires a reference.contains string.' }));
} else {
  const passed = typeof input.artifact.output === 'string' && input.artifact.output.includes(expected);
  process.stdout.write(JSON.stringify({ status: 'scored', score: passed ? 1 : 0,
    reason: passed ? 'The saved final output contains the expected result.' : 'The saved final output does not contain the expected result.' }));
}
