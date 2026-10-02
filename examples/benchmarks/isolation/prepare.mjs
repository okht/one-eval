import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createIsolationCases, ISOLATION_INSTRUCTIONS } from './cases.mjs';
import { createWorkflowCases } from './workflow-cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { out: { type: 'string', default: 'data/isolation-20261002' }, seed: { type: 'string', default: 'one-eval-isolation-20261002' } } });
const directory = path.resolve(values.out);
await mkdir(directory, { recursive: true });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function save(name, value) {
  const file = path.join(directory, name);
  try { await writeFile(file, value, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || digest(await readFile(file)) !== digest(value)) throw error; }
}
const suites = { isolation: createIsolationCases(values.seed), workflow: createWorkflowCases() };
const provenance = { version: 1, synthetic: true, seed: values.seed, conversationStrategy: 'transcript-replay', isolationInstructions: ISOLATION_INSTRUCTIONS, suites: {} };
for (const [name, cases] of Object.entries(suites)) {
  const bytes = cases.map(item => JSON.stringify(item)).join('\n') + '\n';
  await save(`${name}.cases.jsonl`, bytes);
  const grader = path.join(here, name === 'isolation' ? 'grade.mjs' : 'workflow-grade.mjs');
  await save(`${name}.judges.json`, JSON.stringify({ version: 1, concurrency: 2, timeoutMs: 30000, judges: [{ id: `${name}-deterministic`, kind: 'command', command: process.execPath, args: [grader], repeats: 1, weight: 1 }] }, null, 2) + '\n');
  provenance.suites[name] = { cases: cases.length, targetTurnsPerRepeat: cases.reduce((sum, item) => sum + 1 + (item.conversation?.turns.length ?? 0), 0), casesSha256: digest(bytes) };
}
await save('provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ directory, ...provenance }));
