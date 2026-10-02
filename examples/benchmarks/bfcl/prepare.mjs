// Prepare a pinned BFCL subset; target execution is a separate explicit step.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const { values } = parseArgs({ options: {
  out: { type: 'string', default: 'data/expanded-20261002-bfcl' },
  baseline: { type: 'string', default: 'data/expanded-20261002/gsm8k.eval.json' },
  python: { type: 'string', default: '.venv-benchmarks/Scripts/python.exe' },
  seed: { type: 'string', default: 'one-eval-expanded-bfcl-20261002' },
} });
const out = path.resolve(root, values.out);
const revision = 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000';
const repoBase = `https://raw.githubusercontent.com/ShishirPatil/gorilla/${revision}/`;
const prefix = 'berkeley-function-call-leaderboard/';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = [];
async function save(relative, bytes) {
  const file = path.join(out, relative);
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(file)) !== sha(bytes)) throw error; }
  return file;
}
async function download(upstream, relative) {
  const url = repoBase + upstream;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await save(relative, bytes);
  assets.push({ url, path: relative, sha256: sha(bytes), bytes: bytes.length });
  return bytes.toString('utf8');
}
const sourceFiles = [
  'constants/enums.py', 'constants/type_mappings.py', 'constants/model_config.py',
  'eval_checker/ast_eval/ast_checker.py',
  'eval_checker/ast_eval/type_convertor/java_type_converter.py',
  'eval_checker/ast_eval/type_convertor/js_type_converter.py',
  'model_handler/parser/json_parser.py', 'eval_checker/eval_runner.py', 'utils.py',
];
await Promise.all(sourceFiles.map(file => download(`${prefix}bfcl_eval/${file}`, `upstream/bfcl_eval/${file}`)));
await download('LICENSE', 'upstream/LICENSE');
await download(`${prefix}README.md`, 'upstream/README.md');
const populations = {}, selected = {}, cases = [];
for (const [category, count] of [['simple_python', 15], ['multiple', 15], ['irrelevance', 10]]) {
  const dataText = await download(`${prefix}bfcl_eval/data/BFCL_v4_${category}.json`, `upstream/data/BFCL_v4_${category}.json`);
  const rows = dataText.trim().split(/\r?\n/).map(line => JSON.parse(line));
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error(`Duplicate source IDs: ${category}`);
  let answerLines = new Map();
  if (category !== 'irrelevance') {
    const text = await download(`${prefix}bfcl_eval/data/possible_answer/BFCL_v4_${category}.json`, `upstream/data/possible_answer/BFCL_v4_${category}.json`);
    const lines = text.trim().split(/\r?\n/);
    answerLines = new Map(lines.map(line => [JSON.parse(line).id, line]));
    if (answerLines.size !== lines.length) throw new Error(`Duplicate answer IDs: ${category}`);
  }
  populations[category] = rows.length;
  const sample = rows.map((row, index) => ({ row, index, rank: sha(`${values.seed}:${category}:${row.id}`) }))
    .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0).slice(0, count).sort((a, b) => a.index - b.index);
  selected[category] = sample.map(({ row, index }) => ({ id: row.id, sourceIndex: index }));
  for (const { row, index } of sample) {
    if (row.question?.length !== 1 || !Array.isArray(row.question[0]) || row.question[0].some(message => message.role !== 'user')) {
      throw new Error(`Expected one turn of user messages: ${row.id}`);
    }
    if (!Array.isArray(row.function) || !row.function.length) throw new Error(`Missing function definitions: ${row.id}`);
    if (category !== 'irrelevance' && !answerLines.has(row.id)) throw new Error(`Missing answer: ${row.id}`);
    const input = [
      'Choose the function calls needed to answer the user request using only the supplied function definitions.',
      'Return ONLY a JSON array of objects with exactly two keys: "function" (the function name unchanged) and "parameters" (an object of argument values).',
      'Use JSON values, including true/false and arrays. Preserve dots in function names. Do not call any actual tools or execute any code.',
      'If none of the functions can fulfill the request, or a required value is unavailable, return []. Do not invent missing values.',
      'Do not add Markdown fences, explanation, or any text outside the JSON array.',
      '', 'Function definitions:', JSON.stringify(row.function), '', 'User request:',
      row.question[0].map(message => message.content).join('\n\n'),
    ].join('\n');
    cases.push({
      id: `bfcl-${row.id}`, input,
      // Keep the raw answer line so Python preserves integer versus float literals.
      reference: { category, source: row, answerJson: answerLines.get(row.id) ?? null, revision },
      metadata: { benchmark: 'BFCL selected subset / JSON output adaptation', category, sourceId: row.id, sourceIndex: index, revision },
    });
  }
}
const baseline = JSON.parse(await readFile(path.resolve(root, values.baseline), 'utf8'));
const targetPath = path.resolve(here, '../codex-target.mjs');
const python = path.resolve(root, values.python);
const provenance = {
  version: 1, benchmark: 'BFCL selected subset / JSON output adaptation', revision,
  seed: values.seed, repeats: 2, sampling: 'Within each category rank ascending SHA-256(seed:category:sourceId), select 15/15/10, then restore source order. No result-dependent exclusions.',
  populations, selected,
  target: { ...baseline.target.config, binarySha256: sha(await readFile(baseline.target.config.binaryPath)), toolsExecuted: false },
  scorer: {
    pythonPath: python, implementation: 'Pinned original AST checker and JSON parser; original selected runner/format helpers compiled unchanged from their source AST.',
    modelMetadataShim: { modelName: 'one-eval-json', underscore_to_dot: false, reason: 'Prompt-mode JSON preserves function names; avoids importing the unrelated full model-handler registry.' },
    adaptation: 'Main score requires a valid strict JSON call-list protocol. Malformed JSON or protocol violations score zero even when official irrelevance logic would accept them. The official result is retained in reason.',
    dependencies: 'Python >=3.10 standard library only; no bfcl-eval package or model SDK required.',
  },
  scope: 'Single-turn tool selection and argument generation only. No actual function execution, native tool-calling transport, multi-turn, or full BFCL leaderboard comparison.',
  license: 'Apache-2.0; upstream LICENSE retained. Attribute Gorilla / UC Berkeley BFCL authors.',
  promptChanges: 'Original question and function definitions embedded in a custom JSON-only user prompt; ground-truth answers are excluded from target input.',
  assets: assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
};
await save('bfcl.cases.jsonl', cases.map(row => JSON.stringify(row)).join('\n') + '\n');
await save('provenance.json', JSON.stringify(provenance, null, 2) + '\n');
await save('bfcl.eval.json', JSON.stringify({
  version: 1, name: 'bfcl-selected-subset-json-adaptation', cases: './bfcl.cases.jsonl',
  target: { ...baseline.target, path: targetPath },
  execution: { repeats: 2, concurrency: 2, timeoutMs: 180000 },
  files: [path.join(here, 'prepare.mjs'), './provenance.json', baseline.target.config.binaryPath],
}, null, 2) + '\n');
await save('bfcl.judges.json', JSON.stringify({
  version: 1,
  judges: [{ id: 'bfcl-json-adapted', kind: 'command', command: python, args: ['-B', path.join(here, 'grade.py'), path.join(out, 'upstream')], repeats: 1 }],
  concurrency: 2, timeoutMs: 30000,
  files: ['./provenance.json', ...assets.map(asset => asset.path)],
}, null, 2) + '\n');
console.log(JSON.stringify({ directory: out, cases: cases.length, repeats: 2, plannedExecutions: cases.length * 2, selected }));
