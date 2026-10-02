// Download pinned upstream assets and create reproducible one-eval smoke plans.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { values } = parseArgs({ options: {
  'codex-binary': { type: 'string' }, python: { type: 'string' },
  count: { type: 'string', default: '12' }, repeats: { type: 'string', default: '2' },
  seed: { type: 'string', default: 'one-eval-smoke-20261002' },
  out: { type: 'string', default: 'data/open-source-smoke-20261002' },
  model: { type: 'string', default: 'gpt-5.6-sol' },
} });
if (!values['codex-binary'] || !values.python) throw new Error('Provide --codex-binary and --python as absolute executable paths.');
for (const key of ['codex-binary', 'python']) if (!path.isAbsolute(values[key])) throw new Error(`${key} must be absolute.`);
const count = Number(values.count), repeats = Number(values.repeats);
if (!Number.isInteger(count) || count < 1 || count > 541 || !Number.isInteger(repeats) || repeats < 1) throw new Error('Invalid count or repeats.');
const out = path.resolve(root, values.out);
const sha = data => createHash('sha256').update(data).digest('hex');
const revisions = { gsm8k: '3101c7d5072418e28b9008a6636bde82a006892c', ifeval: 'e6890f85757dd84e27ca6df2dd30651dafad28e0' };
const assets = [];
const nltkRevision = '550b6625bcef1f2abff2ff770a5a0d272c9c6b2a';
async function save(relative, data) {
  const file = path.join(out, relative);
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, data, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || sha(await readFile(file)) !== sha(data)) throw error; }
  return file;
}
async function download(dataset, upstream, local) {
  const repo = dataset === 'gsm8k' ? 'openai/grade-school-math' : 'google-research/google-research';
  const url = `https://raw.githubusercontent.com/${repo}/${revisions[dataset]}/${upstream}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const file = await save(local, bytes);
  assets.push({ dataset, url, path: path.relative(out, file).replaceAll('\\', '/'), sha256: sha(bytes), bytes: bytes.length });
  return bytes.toString('utf8');
}
const gsmText = await download('gsm8k', 'grade_school_math/data/test.jsonl', 'upstream/gsm8k/test.jsonl');
await download('gsm8k', 'LICENSE', 'upstream/gsm8k/LICENSE');
await download('gsm8k', 'grade_school_math/dataset.py', 'upstream/gsm8k/dataset.py');
const ifText = await download('ifeval', 'instruction_following_eval/data/input_data.jsonl', 'upstream/ifeval/input_data.jsonl');
await download('ifeval', 'README.md', 'upstream/ifeval/DATA_LICENSE_NOTICE.md');
await download('ifeval', 'LICENSE', 'upstream/ifeval/LICENSE');
for (const file of ['evaluation_lib.py', 'instructions.py', 'instructions_registry.py', 'instructions_util.py']) {
  await download('ifeval', `instruction_following_eval/${file}`, `upstream/ifeval/instruction_following_eval/${file}`);
}
// NLTK documents manual data installation; download only its official pinned package.
const nltkUrl = `https://raw.githubusercontent.com/nltk/nltk_data/${nltkRevision}/packages/tokenizers/punkt_tab.zip`;
const nltkResponse = await fetch(nltkUrl, { signal: AbortSignal.timeout(60000) });
if (!nltkResponse.ok) throw new Error(`NLTK download failed: ${nltkResponse.status}`);
const nltkBytes = Buffer.from(await nltkResponse.arrayBuffer());
const nltkZip = await save('upstream/nltk/punkt_tab.zip', nltkBytes);
assets.push({ dataset: 'nltk', url: nltkUrl, path: 'upstream/nltk/punkt_tab.zip', sha256: sha(nltkBytes), bytes: nltkBytes.length });
execFileSync(values.python, [path.join(here, 'unpack-nltk.py'), nltkZip, path.join(out, 'nltk_data')], { stdio: 'inherit' });
const jsonLines = text => text.trim().split(/\r?\n/).map(line => JSON.parse(line));
const originals = { gsm8k: jsonLines(gsmText), ifeval: jsonLines(ifText) };
const selected = {};
for (const dataset of ['gsm8k', 'ifeval']) {
  const rows = originals[dataset].map((row, index) => ({ row, index, rank: sha(`${values.seed}:${dataset}:${index}`) }))
    .sort((a, b) => a.rank.localeCompare(b.rank)).slice(0, count).sort((a, b) => a.index - b.index);
  selected[dataset] = rows.map(({ row, index }) => ({ sourceIndex: index, sourceKey: row.key ?? null }));
  const cases = rows.map(({ row, index }) => ({
    id: `${dataset}-${dataset === 'ifeval' ? row.key : index}`,
    input: dataset === 'gsm8k' ? `${row.question}\n\nShow your reasoning and end your answer with a line in the form: #### <number>` : row.prompt,
    reference: dataset === 'gsm8k' ? { answer: row.answer } : row,
    metadata: { dataset, sourceIndex: index, revision: revisions[dataset] },
  }));
  await save(`${dataset}.cases.jsonl`, cases.map(row => JSON.stringify(row)).join('\n') + '\n');
  const evaluation = {
    version: 1, name: `${dataset}-codex-smoke`, cases: `./${dataset}.cases.jsonl`,
    target: { kind: 'module', path: path.join(here, 'codex-target.mjs'),
      config: { binaryPath: values['codex-binary'], model: values.model },
      isolation: { mode: 'managed', scope: 'independent', evidence: 'Fresh ephemeral Codex process and empty temporary working directory per single-turn trial; tools, memory, plugins and project instructions disabled.' }, retrySafe: true },
    execution: { repeats, concurrency: 2, timeoutMs: 180000 },
    files: [path.join(here, 'prepare.mjs'), './provenance.json'],
  };
  await save(`${dataset}.eval.json`, JSON.stringify(evaluation, null, 2) + '\n');
  const judge = dataset === 'gsm8k'
    ? { id: 'gsm8k-exact', kind: 'command', command: process.execPath, args: [path.join(here, 'gsm8k-grade.mjs')], repeats: 1 }
    : { id: 'ifeval-strict', kind: 'command', command: values.python, args: [path.join(here, 'ifeval-grade.py'), path.join(out, 'upstream/ifeval')], env: { NLTK_DATA: 'ONE_EVAL_NLTK_DATA' }, repeats: 1 };
  const files = dataset === 'ifeval' ? [path.join(here, 'requirements.lock.txt'), ...assets.filter(a => a.dataset === dataset || a.dataset === 'nltk').map(a => a.path),
    ...['abbrev_types.txt', 'collocations.tab', 'ortho_context.tab', 'sent_starters.txt'].map(file => `nltk_data/tokenizers/punkt_tab/english/${file}`)] : ['upstream/gsm8k/dataset.py'];
  await save(`${dataset}.judges.json`, JSON.stringify({ version: 1, judges: [judge], concurrency: 2, timeoutMs: 30000, files }, null, 2) + '\n');
}
const provenance = {
  version: 1, seed: values.seed, count, repeats, revisions, nltkRevision,
  sampling: 'Rank every source row by ascending SHA-256(seed + colon + dataset + colon + zero-based index), take first count, restore source order; no result-dependent exclusions.',
  sourceCounts: Object.fromEntries(Object.entries(originals).map(([name, rows]) => [name, rows.length])), selected,
  target: { name: 'Codex CLI', model: values.model, binaryPath: values['codex-binary'], binarySha256: sha(await readFile(values['codex-binary'])), toolsEnabled: false },
  licenses: { gsm8k: 'MIT; Copyright (c) 2021 OpenAI', ifevalData: 'CC BY 4.0; Google Research; see pinned repository README', ifevalCode: 'Apache-2.0; Google Research' },
  promptChanges: { gsm8k: 'Append reasoning and #### final-number format instruction.', ifeval: 'Original prompt unchanged.' },
  assets: assets.sort((a, b) => a.path.localeCompare(b.path)),
};
await save('provenance.json', JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ directory: out, casesPerDataset: count, repeats, plannedExecutions: count * repeats * 2, selected }));
