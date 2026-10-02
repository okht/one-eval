# Open-source benchmark smoke test

This example runs real single-turn responses through an authenticated Codex CLI.
It samples GSM8K and IFEval, repeats target execution twice, grades saved outputs,
and audits independent thread IDs. It does not exercise tool use or stateful business workflows.

The first run uses 12 questions from each dataset. Sampling is deterministic SHA-256
ranking with seed `one-eval-smoke-20261002`, chosen before model responses are seen.
Repeated calls are not additional independent questions. Scores are integration
evidence, not full benchmark results or evidence that the questions were unseen in training.

## Sources and scoring

- [OpenAI GSM8K](https://github.com/openai/grade-school-math), MIT, commit
  `3101c7d5072418e28b9008a6636bde82a006892c`: official test split, 1,319 rows.
  The grader preserves the official `#### ` extraction, comma removal and exact
  string comparison. The prompt requests that final-answer marker. A missing marker
  scores zero. Numeric strings such as `18` and `18.0` remain different.
- [Google Research IFEval](https://github.com/google-research/google-research/tree/e6890f85757dd84e27ca6df2dd30651dafad28e0/instruction_following_eval),
  commit `e6890f85757dd84e27ca6df2dd30651dafad28e0`: 541 original prompts.
  Prompts are unchanged. Four official Python source files are downloaded verbatim.
  The main score is strict prompt-level accuracy (all listed checks must pass).
  Per-instruction decisions and loose scores are retained separately. Language
  detection uses seed 0. Each saved response is graded separately, including repeats.
  Under the pinned repository README, data is CC BY 4.0 and code is Apache-2.0.
  Credit: Jeffrey Zhou and the IFEval/Google Research authors, *Instruction-Following
  Evaluation for Large Language Models* (2023).
- The English Punkt text model comes from the pinned official `nltk/nltk_data`
  package. Its README and license are retained. Python dependencies are locked in
  `requirements.lock.txt`; the model archive and individual model files are hashed.

## Reproduce on Windows

Use PowerShell 7, Node 22.22 or later, Python 3.12 and uv. The Codex adapter deliberately
requires **CLI 0.144.6**; pass the native executable, not a `.cmd`/`.ps1` shim.
The account must already be authenticated. Each requested trial consumes model usage.

```powershell
npm ci --ignore-scripts
npm run build
uv venv --python 3.12 .venv-benchmarks
uv pip sync --python .venv-benchmarks/Scripts/python.exe examples/benchmarks/requirements.lock.txt
node examples/benchmarks/prepare.mjs --out data/open-source-smoke-20261002-v1 --codex-binary C:/absolute/path/to/codex.exe --python C:/absolute/path/to/one-eval/.venv-benchmarks/Scripts/python.exe
$env:ONE_EVAL_NLTK_DATA = Join-Path $PWD 'data/open-source-smoke-20261002-v1/nltk_data'
node dist/cli.js run data/open-source-smoke-20261002-v1/gsm8k.eval.json --out runs/opensource-20261002-gsm8k --mode exploratory
node dist/cli.js grade runs/opensource-20261002-gsm8k --config data/open-source-smoke-20261002-v1/gsm8k.judges.json --mode exploratory
node dist/cli.js report runs/opensource-20261002-gsm8k | Set-Content -Encoding utf8 runs/opensource-20261002-gsm8k/report.json
node dist/cli.js run data/open-source-smoke-20261002-v1/ifeval.eval.json --out runs/opensource-20261002-ifeval --mode exploratory
node dist/cli.js grade runs/opensource-20261002-ifeval --config data/open-source-smoke-20261002-v1/ifeval.judges.json --mode exploratory
node dist/cli.js report runs/opensource-20261002-ifeval | Set-Content -Encoding utf8 runs/opensource-20261002-ifeval/report.json
node examples/benchmarks/summarize.mjs runs/opensource-20261002-gsm8k runs/opensource-20261002-ifeval
```

Use a new output directory for a new run. `prepare.mjs` refuses to overwrite
different prepared inputs. Its provenance file retains selected source indices,
upstream commits, download URLs, hashes, prompt modifications and executable hash.
The NLTK package is installed manually using its documented installation method;
only named English model files and README are extracted, with no archive-controlled paths.

## Isolation and evidence boundary

Each trial starts a fresh ephemeral Codex process in a new empty directory outside
the repository. User config, project instructions, memory, plugins, browser, shell
and other enabled tool features are disabled. The adapter only forwards the case
input and rejects observed tool events. It checks unique thread IDs and waits for
process termination before directory cleanup. References remain in the grader side.
This verifies the local invocation contract; it does not establish an OS-level read
sandbox or prove anything about hidden state on the remote model service.

The adapter accepts one user message and one execution per session. Normal aborts
terminate the child process tree. Recovery after an abrupt parent-process crash is
not automatic, because old child-process termination cannot be proven from a new
adapter instance. Core evaluation output remains blocked in that situation.

Deterministic graders run once per saved answer. Running `grade` again with the
same configuration reuses completed grade records without invoking the target.
`summarize.mjs` requires complete reports and checks all 48 calls, IDs, message
histories and tool events before producing `results/open-source-smoke-20261002.json`.
