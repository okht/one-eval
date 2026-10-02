import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATION_INSTRUCTIONS } from './isolation/cases.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const data = path.resolve(process.argv[2] ?? path.join(root, 'data/expanded-20261002-agent'));
const baseConfig = path.resolve(process.argv[3] ?? path.join(root, 'data/expanded-20261002/gsm8k.eval.json'));
const baseline = JSON.parse(await readFile(baseConfig, 'utf8'));
const files = ['agent-workflow/fixture.mjs', 'agent-workflow/server.mjs', 'isolation/cases.mjs',
  'isolation/workflow-cases.mjs', 'isolation/prepare.mjs', 'configure-agent-challenges.mjs'].map(file => path.join(here, file));
files.push(path.join(root, 'package.json'), path.join(root, 'package-lock.json'), './provenance.json');
for (const name of ['isolation', 'workflow']) {
  const config = {
    version: 1, name: `local-${name}-codex-expanded`, cases: `./${name}.cases.jsonl`,
    target: {
      kind: 'module', path: path.join(here, 'agent-workflow/target.mjs'),
      config: { ...baseline.target.config, enableTools: name === 'workflow',
        ...(name === 'isolation' ? { instructions: ISOLATION_INSTRUCTIONS } : {}) },
      isolation: { mode: 'managed', scope: 'independent',
        evidence: 'Fresh trial database and transcript; each turn uses a new ephemeral CLI thread with only the same-trial transcript. Synthetic business state persists only within one trial.' },
      retrySafe: true,
    },
    execution: { repeats: 2, concurrency: name === 'isolation' ? 1 : 2, timeoutMs: 360000 }, files,
  };
  const file = path.join(data, `${name}.eval.json`), text = JSON.stringify(config, null, 2) + '\n';
  try { await writeFile(file, text, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== text) throw error; }
}
console.log(JSON.stringify({ data, suites: ['isolation', 'workflow'], trials: 32, plannedModelCalls: 60 }));
