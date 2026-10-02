import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invokeCodex, EXPECTED_CLI_VERSION } from './codex-run.mjs';

const binaryPath = process.argv[2];
const output = path.resolve(process.argv[3]);
const version = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
if (version !== EXPECTED_CLI_VERSION) throw new Error(`Unexpected Codex version: ${version}`);
const cached = JSON.parse(await readFile(path.join(process.env.USERPROFILE, '.codex/models_cache.json'), 'utf8'));
const models = ['gpt-5.6-sol', 'gpt-5.6-luna'];
if (models.some(model => !cached.models.some(item => item.slug === model && item.visibility === 'list'))) throw new Error('Requested model absent from local supported-model metadata');
await mkdir(output, { recursive: true });
const results = [];
for (const model of models) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'one-eval-acceptance-probe-'));
  try {
    const result = await invokeCodex({ binaryPath, model, cwd, evidenceDir: path.join(output, 'calls'), prompt: 'Return exactly {"status":"scored","score":1,"reason":"ready"}. Do not use tools.' });
    const parsed = JSON.parse(result.output);
    if (parsed.status !== 'scored' || parsed.score !== 1) throw new Error('Unexpected readiness response');
    results.push({ requestedModel: model, threadId: result.threadId, callId: result.callId, ready: true });
  } finally { await rm(cwd, { recursive: true }); }
}
await writeFile(path.join(output, 'probe.json'), JSON.stringify({ cliVersion: version, modelMetadataSource: 'Local models_cache.json (selected slugs only)', models: results }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ cliVersion: version, models: results }));
