import { lstat, mkdir, open, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type StarterTemplate = 'offline' | 'openai-compatible' | 'http' | 'managed';
export interface StarterOptions {
  directory: string;
  template: StarterTemplate;
  endpoint?: string;
  model?: string;
  endpointEnv?: string;
  apiKeyEnv?: string;
  modelEnv?: string;
}
export interface StarterResult {
  directory: string;
  template: StarterTemplate;
  files: string[];
  requiredEnv: string[];
  nextSteps: string[];
}

const templates = new Set<StarterTemplate>(['offline', 'openai-compatible', 'http', 'managed']);
const envReference = (name: string) => '${ENV:' + name + '}';
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const quotedPath = (value: string) => `'${value.replaceAll("'", "''")}'`;

function environmentName(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Starter environment names must be valid variable identifiers');
  return name;
}

function endpointExample(value: string | undefined, template: StarterTemplate): string {
  if (value === undefined) return template === 'openai-compatible' ? 'http://127.0.0.1:8000/v1' : 'http://127.0.0.1:8000/invoke';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || /[\r\n]/.test(value) || value !== value.trim()) throw new Error('Starter endpoint must be an HTTP or HTTPS URL');
  if (url.username || url.password || [...url.searchParams.keys()].some((key) => /key|token|secret|password|authorization/i.test(key))) throw new Error('Keep endpoint credentials in environment variables, not in the endpoint URL');
  return value;
}

async function templateSource(name: string): Promise<string> {
  return readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');
}

/** Creates a reviewable starter without contacting its endpoint or loading credentials. */
export async function generateStarter(options: StarterOptions): Promise<StarterResult> {
  if (!options || typeof options.directory !== 'string' || !options.directory.trim() || !templates.has(options.template)) throw new Error('Starter requires a directory and a supported template');
  if (Object.keys(options).some((key) => !['directory', 'template', 'endpoint', 'model', 'endpointEnv', 'apiKeyEnv', 'modelEnv'].includes(key))) throw new Error('Unknown starter option; credentials must be provided at runtime through environment variables');
  if (options.model !== undefined && (typeof options.model !== 'string' || !options.model.trim() || /[\r\n]/.test(options.model))) throw new Error('Starter model must be a nonempty single-line name');
  const directory = path.resolve(options.directory);
  const endpointEnv = environmentName(options.endpointEnv, 'ONE_EVAL_ENDPOINT');
  const apiKeyEnv = environmentName(options.apiKeyEnv, 'ONE_EVAL_API_KEY');
  const modelEnv = environmentName(options.modelEnv, 'ONE_EVAL_MODEL');
  if (new Set([endpointEnv, apiKeyEnv, modelEnv]).size !== 3) throw new Error('Starter environment names must be distinct');
  const endpoint = endpointExample(options.endpoint, options.template);
  const model = options.model ?? 'your-model-name';
  const remote = options.template !== 'offline';
  const requiredEnv = remote ? [endpointEnv, apiKeyEnv, ...(options.template === 'openai-compatible' ? [modelEnv] : [])] : [];
  const nextSteps = [
    `cd ${quotedPath(directory)}`,
    'one-eval probe eval.json --out runs/probe',
    'one-eval run eval.json --out runs/eval --preflight runs/probe/admission.json',
    'one-eval calibrate calibration.json --config judges.json --out runs/calibration',
    'one-eval grade runs/eval --config judges.json --calibration runs/calibration/admission.json',
    'one-eval report runs/eval',
  ];
  const declaration = 'The service owner must confirm that requests are stateless. The runner sends a fresh per-case message list; remote hidden memory and business state are not independently verified.';
  let target: unknown;
  if (options.template === 'offline' || options.template === 'managed') {
    target = { kind: 'module', path: './target.mjs', ...(options.template === 'managed' ? { config: { endpoint: envReference(endpointEnv), apiKey: envReference(apiKeyEnv) } } : {}),
      isolation: { mode: 'managed', scope: 'independent', evidence: options.template === 'offline' ? 'The local fixture creates, verifies and releases an independent in-memory session for each trial.' : 'Unimplemented lifecycle scaffold: verification must fail until real remote sessions, memory and business state are checked.' },
      retrySafe: options.template === 'offline' };
  } else {
    const provider = options.template === 'openai-compatible'
      ? { id: 'openai:chat', config: { apiBaseUrl: envReference(endpointEnv), apiKey: envReference(apiKeyEnv), model: envReference(modelEnv), omitDefaults: true, maxRetries: 0 } }
      : { id: 'http', config: { url: envReference(endpointEnv), method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${envReference(apiKeyEnv)}` },
          // Returning an object bypasses template coercion and the provider's string-body warning, which includes headers.
          body: {}, transformRequest: '({ input: vars.messages[vars.messages.length - 1].content, messages: vars.messages, sessionId: vars.sessionId })',
          transformResponse: 'json.output', validateStatus: 'status >= 200 && status < 300', maxRetries: 0 } };
    target = { kind: 'provider', provider, isolation: { mode: 'stateless', scope: 'independent', evidence: declaration }, retrySafe: false };
  }
  const files: Record<string, string> = {
    'eval.json': json({ version: 1, name: `${options.template} integration starter`, cases: './cases.json', target, execution: { repeats: 2, concurrency: 1, timeoutMs: 30_000, maxAttempts: 4 } }),
    'cases.json': json([
      { id: 'ready', input: 'Echo exactly: READY', reference: 'READY', metadata: { category: 'integration' } },
      { id: 'unicode-and-history', input: 'Echo exactly: Café "first"\nsecond line', reference: 'Final "quoted" answer\nwith a newline', conversation: { mode: 'scripted', turns: ['Echo exactly: Final "quoted" answer\nwith a newline'] }, metadata: { category: 'integration' } },
    ]),
    'judges.json': json({ version: 1, judges: [{ id: 'exact-reference', kind: 'command', command: 'node', args: ['./grade.mjs'], repeats: 1, weight: 1 }], concurrency: 1, timeoutMs: 10_000 }),
    'calibration.json': json({ version: 1, fixtures: [
      { id: 'correct', label: 'positive', input: 'Echo exactly: READY', reference: 'READY', output: 'READY', expected: { status: 'scored', minScore: 1, maxScore: 1 } },
      { id: 'wrong', label: 'negative', input: 'Echo exactly: READY', reference: 'READY', output: 'WRONG', expected: { status: 'scored', minScore: 0, maxScore: 0 } },
      { id: 'empty', label: 'edge', input: 'Echo exactly: READY', reference: 'READY', output: '', expected: { status: 'scored', minScore: 0, maxScore: 0 } },
      { id: 'missing-reference', label: 'edge', input: 'Answer without a reference', output: 'An answer', expected: { status: 'insufficient_evidence' } },
    ] }),
    'grade.mjs': await templateSource('common/grade.mjs'),
    '.gitignore': 'runs/\n.env\n.env.*\n!.env.example\n',
  };
  if (options.template === 'offline' || options.template === 'managed') files['target.mjs'] = await templateSource(`${options.template}/target.mjs`);
  if (remote) files['.env.example'] = `# Inert examples only. one-eval does not automatically load this file.\n${endpointEnv}=${JSON.stringify(endpoint)}\n${apiKeyEnv}="replace-with-your-key-or-an-unused-local-placeholder"\n${options.template === 'openai-compatible' ? `${modelEnv}=${JSON.stringify(model)}\n` : ''}`;
  files['README.md'] = `# ${options.template} evaluation starter\n\n` +
    (options.template === 'offline' ? 'This deterministic fixture runs entirely offline. Its scores verify the evaluation plumbing and exact-match rule.\n\n' :
      `Set ${requiredEnv.map((name) => '`' + name + '`').join(', ')} in the process environment before probing. `.concat('`.env.example` is an inert reference; one-eval does not load it automatically. Never put real credentials in JSON, source files or command-line flags.\n\n')) +
    (options.template === 'managed' ? 'Implement every TODO in `target.mjs` first. The default prepare throws and verify returns false, so a formal run cannot pass preflight. Create and verify remote conversation, persistent memory, workspace/database fixtures and business-side-effect namespaces; cleanup and recovery must verify their real outcomes. Add imported helper files to `eval.json` `files` so they are frozen with the adapter.\n\n' :
      options.template === 'offline' ? '' : 'The provider declares stateless behavior; remote hidden memory and external business state remain unverified. Confirm the service contract or choose the managed template. A fresh runner session ID alone does not prove service isolation.\n\n') +
    (options.template === 'openai-compatible' ? 'Uses the installed Promptfoo 0.123.1 `openai:chat` provider. The endpoint is the API base URL (for example `http://127.0.0.1:8000/v1`); Promptfoo appends `/chat/completions`. The model name comes from the environment. No default model is silently selected by this starter.\n\n' :
      options.template === 'http' ? 'Uses the installed Promptfoo 0.123.1 HTTP provider. POST JSON contains `input` (the current user message), `messages` (the full same-case transcript) and `sessionId` (runner bookkeeping). The service must return `{ "output": "text" }`. Adapt `transformRequest` and the response expression to your API contract; non-2xx status fails. Remove the Authorization header for an unauthenticated service. The object request transform preserves JSON-looking user text as strings.\n\n' : '') +
    'The sample dataset asks for exact echoes. `grade.mjs` compares the saved final answer to a user-supplied string reference; whitespace and punctuation count. Missing reference produces insufficient evidence. Replace the cases and scoring rule for your real task, and update the calibration anchors whenever that rule changes.\n\n' +
    '## Formal workflow\n\nRun from this directory with `one-eval` available on PATH. Probe and calibration make real target/grader calls. Receipts match the frozen configuration; changing files requires fresh receipts. The explicit `--mode exploratory` path is available for development without formal admission.\n\n```text\n' + nextSteps.slice(1).join('\n') + '\n```\n\n' +
    'Use a new output directory when repeating this workflow. Each probe evaluates a small sample; it does not certify all cases or external state.\n';

  await mkdir(path.dirname(directory), { recursive: true });
  try { await mkdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Starter destination must be an ordinary empty directory');
  if ((await readdir(directory)).length) throw new Error('Starter destination is not empty; no user files were overwritten');
  const lock = path.join(directory, '.one-eval-init.lock');
  const handle = await open(lock, 'wx');
  const created: string[] = [];
  try {
    if ((await readdir(directory)).some((file) => file !== path.basename(lock))) throw new Error('Starter destination changed during initialization; no user files were overwritten');
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(directory, name), content, { flag: 'wx' });
      created.push(name);
    }
  } catch (error) {
    throw new Error(`Starter initialization stopped without overwriting files; files created by this attempt: ${created.join(', ') || '(none)'}`, { cause: error });
  } finally {
    await handle.close();
    await unlink(lock);
  }
  return { directory, template: options.template, files: created, requiredEnv, nextSteps };
}
