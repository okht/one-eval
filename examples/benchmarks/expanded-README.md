# Expanded benchmark run

This run expands the first smoke test to 256 distinct cases and two repeats:
100 GSM8K, 100 IFEval, 40 BFCL-adapted function-generation cases, eight local
workflow cases and eight local context challenges. The plan contains 512 trial
slots and 540 successful model turns when complete. Failed execution attempts
are recorded separately. All targets request `gpt-5.6-sol` via Codex CLI 0.144.6.

The three public datasets and the two synthetic suites have separate scores.
Do not average them into an overall benchmark score. The latter two are integration
acceptance challenges, not externally validated model benchmarks.

## Prepare in a clean checkout

First install the Node and Python dependencies described in [README.md](README.md).
Use PowerShell 7. Replace the two absolute executable paths:

```powershell
node examples/benchmarks/prepare.mjs --count 100 --repeats 2 --out data/expanded-20261002 --codex-binary C:/absolute/path/to/codex.exe --python C:/absolute/path/to/one-eval/.venv-benchmarks/Scripts/python.exe
foreach ($name in @('gsm8k','ifeval')) {
  $file = Join-Path $PWD "data/expanded-20261002/$name.eval.json"
  $config = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  $config.name = "$name-codex-expanded"
  $config.execution.concurrency = 4
  $config | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $file -Encoding utf8
}
node examples/benchmarks/bfcl/prepare.mjs
node examples/benchmarks/isolation/prepare.mjs --out data/expanded-20261002-agent-v2
node examples/benchmarks/configure-agent-challenges.mjs data/expanded-20261002-agent-v2
```

These commands create frozen input files; they refuse to overwrite different
prepared contents. Use new data and run directory names for a new preparation.
The original smoke run inputs and outputs remain unchanged. The expanded GSM8K
and IFEval selections use the same ranking seed and therefore include the original
12 questions from each dataset. IFEval now includes all 25 instruction types in
the pinned 541-row source, although six types have only one or two selected checks.

## Execute, grade and report

Set the IFEval tokenizer data directory:

```powershell
$env:ONE_EVAL_NLTK_DATA = Join-Path $PWD 'data/expanded-20261002/nltk_data'
```

These historical benchmark reproductions use explicit exploratory mode. Formal evaluation additionally requires a target probe and grader calibration; see [admission](../../docs/admission.md).

For each row below, run `node dist/cli.js run <eval> --out <run> --mode exploratory`, then
`node dist/cli.js grade <run> --config <judges> --mode exploratory`, and finally
`node dist/cli.js report <run> | Set-Content -Encoding utf8 <run>/report.json`.
Inspect each command's JSON and exit status before proceeding.

| Suite | Config directory | Eval and judge basename | Run directory |
| --- | --- | --- | --- |
| GSM8K | `data/expanded-20261002` | `gsm8k` | `runs/expanded-20261002-gsm8k` |
| IFEval | `data/expanded-20261002` | `ifeval` | `runs/expanded-20261002-ifeval` |
| BFCL | `data/expanded-20261002-bfcl` | `bfcl` | `runs/expanded-20261002-bfcl` |
| Context | `data/expanded-20261002-agent-v2` | `isolation` | `runs/expanded-20261002-isolation` |
| Workflow | `data/expanded-20261002-agent-v2` | `workflow` | `runs/expanded-20261002-workflow` |

The basename expands to `<name>.eval.json` and `<name>.judges.json`. Only retry
execution errors after inspection, using `resume <run> --retry-errors`. Wrong
answers remain scored outcomes and are not rerun. Old attempts remain on disk.
The adapters use disposable synthetic state and explicitly declare retries safe;
this does not establish retry safety for external business systems.

When grading source changes, a new grading version is created and prior records
remain available. Pass `--grading-version <hash-from-grade>` to `report` when more
than one version exists. The expanded run exposed Windows GBK stdin corruption;
both Python grader entry points now explicitly use UTF-8. All affected saved
answers were regraded under new versions, with no new target calls. Never retry
only the records that raised decoding errors: silent text corruption can also
change apparently successful scores.

After all five reports are complete:

```powershell
node examples/benchmarks/expanded-summary.mjs runs/expanded-20261002-gsm8k runs/expanded-20261002-ifeval runs/expanded-20261002-bfcl runs/expanded-20261002-isolation runs/expanded-20261002-workflow
```

The summary retains failed attempts, identifies per-case score changes, keeps
BFCL category and IFEval instruction metrics, and audits successful thread IDs,
same-case messages and observed MCP calls. It refuses incomplete reports and
detects reruns of already-completed responses. Token totals cover completed
attempts only because some failed CLI invocations provide no usage evidence.

## Interpretation

- GSM8K follows its original strict numeric-string matcher. Numerically equivalent
  `1.00` and `1` remain different; this is explicitly retained for comparability.
- IFEval follows the original strict/loose checkers. Contradictory instructions,
  source-label errors and tokenizer effects are retained and annotated separately.
- [BFCL](bfcl/README.md) uses a JSON-output prompt adaptation and strict protocol
  gate around original official checking code. These results are not official
  leaderboard scores and do not involve executing those generated functions.
- [Local workflow](agent-workflow/README.md) uses real MCP calls to a synthetic
  order database. Exact refund reasons, complete final state and tool audit evidence
  are checked. No real orders or payments are involved.
- [Context challenges](isolation/README.md) check actual token recall, overwrite,
  clearing and blank-case responses. Dialogue uses per-turn transcript replay;
  it does not exercise a native resumed remote session.

Review the saved failures before drawing quality conclusions. Scores are conditional
on the dataset, prompt, target protocol and grader, and the repetitions are correlated.
