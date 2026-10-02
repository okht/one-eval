# BFCL selected subset / JSON output adaptation

This integration evaluates single-turn function selection and argument generation
using a selected BFCL subset. It never executes the generated functions. It does
not measure native tool-calling transport, multi-turn behavior, or full BFCL
leaderboard performance. The JSON-only prompt and output-validation gate are
explicit adaptations, so these scores are not directly comparable to the leaderboard.

## Sources and license

The [official BFCL leaderboard](https://gorilla.cs.berkeley.edu/leaderboard.html)
identifies the reproducibility checkpoint
`f7cf7359b7ac615a0b294831c5ba2bc95ee4a000`. The downloader uses that exact commit
of [ShishirPatil/gorilla](https://github.com/ShishirPatil/gorilla/tree/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000/berkeley-function-call-leaderboard)
for every data and source file. BFCL is from the Gorilla / UC Berkeley team,
including Shishir G. Patil, Huanzhi Mao, Charlie Cheng-Jie Ji, Fanjia Yan,
Vishnu Suresh, Ion Stoica, and Joseph E. Gonzalez.

The upstream repository and official dataset card specify Apache-2.0. The
prepared directory retains the original `upstream/LICENSE` and README. Original
Python source files are downloaded without edits; their hashes, download URLs,
sizes, and revision are saved in `provenance.json`.

## Preparation

Use Node.js and Python >=3.10. No BFCL package, model weights, model-serving
framework, API SDK, or additional Python dependency is needed.

From the repository root:

```text
node examples/benchmarks/bfcl/prepare.mjs
```

The defaults are:

- Output directory: `data/expanded-20261002-bfcl`.
- Target configuration source: `data/expanded-20261002/gsm8k.eval.json`.
- Python command: `.venv-benchmarks/Scripts/python.exe`.
- Seed: `one-eval-expanded-bfcl-20261002`.
- Sample: 15 of 400 `simple_python`, 15 of 200 `multiple`, and 10 of 240
  `irrelevance` entries.
- Execution: two repeats, concurrency two, 180-second trial deadline.
- Scoring: one command-grader invocation per saved answer.

Override paths with `--out`, `--baseline`, and `--python`. Existing prepared
files can only be reused when their contents match exactly. Use a new output
directory after changing the preparation or grading protocol.

The deterministic sampler ranks each category by
`SHA-256(seed + ':' + category + ':' + sourceId)`, takes the planned count, and
restores source order. It never chooses or excludes cases based on model results.
The original user request and function definitions are included in target input.
Ground-truth answers are stored only in `reference`; their original JSON lines
are retained to preserve integer/float distinctions for the Python checker.

Prepared files include `bfcl.cases.jsonl`, `bfcl.eval.json`, `bfcl.judges.json`,
`provenance.json`, and the pinned upstream files. Target execution and scoring are
separate operations:

```text
node dist/cli.js run data/expanded-20261002-bfcl/bfcl.eval.json --out runs/bfcl-example --mode exploratory
node dist/cli.js grade runs/bfcl-example --config data/expanded-20261002-bfcl/bfcl.judges.json --mode exploratory
node dist/cli.js report runs/bfcl-example
```

## Scoring boundary

The response protocol is a JSON array of objects with exactly `function` and
`parameters` keys. Function names retain dots. Parameters are JSON objects;
`[]` means no suitable call. Markdown fences, surrounding prose, non-finite
numbers, duplicate JSON keys, and other protocol violations receive a main
score of zero.

`grade.py` reuses the original upstream:

- `parse_json_function_call` decoder;
- complete `ast_checker` module and its type converters;
- format checks from `utils.py`;
- individual AST and relevance evaluation functions from `eval_runner.py`.

The last two modules also import unrelated runtime/model components. The wrapper
selects their required function definitions using Python's AST and compiles those
original nodes unchanged. It does not rewrite their scoring rules. It supplies a
single model-metadata entry named `one-eval-json`, with `underscore_to_dot=False`,
instead of importing the full model registry. That metadata choice matches the
prompt's instruction to retain function names. The original registry source is
also retained for audit.

Official irrelevance scoring treats failed decoding as no call. The main score
here additionally requires a valid JSON protocol. Every grade's JSON-encoded
`reason` includes `protocol_valid`, `protocol_error`, `official_valid`, the
upstream error category, and original checker errors. Thus a malformed output
can have `official_valid=true` and main `score=0`. An irrelevance pass establishes
the absence of a generated function call; it does not evaluate the quality of a
refusal explanation.

The main score is 1 only when both the protocol and official checker pass. Scorer
setup failures or invalid benchmark references exit nonzero, keeping grader
errors separate from a model's score of zero. Each saved response is graded
independently. Category means and the 15/15/10 subset composition should be shown
alongside any aggregate; the aggregate is a sample-weighted result rather than
BFCL's official overall metric.

## Validation

```text
node --import tsx --test --test-concurrency=1 tests/bfcl.test.ts
```

The prepared-data checks verify every downloaded asset hash, reconstruct the
sample, match source rows, and exercise each selected case with an official
accepted answer and an opposite outcome. Further checks cover wrong function
names, missing/extra arguments, parameter types, optional values, malformed JSON,
the official irrelevance boundary, and command-protocol errors. Tests that need
downloaded data report a skip when preparation has not run; protocol tests need
only Python. Set `ONE_EVAL_TEST_PYTHON` to choose another Python executable.
