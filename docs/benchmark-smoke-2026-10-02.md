# Open-source benchmark smoke report — 2026-10-02

one-eval completed 48 real target calls and 48 deterministic grades using
`gpt-5.6-sol` through the authenticated Codex CLI 0.144.6. Both runs finished
without execution errors, grading errors, missing records or blocked state.

| Dataset | Distinct questions | Repeats | First repeat | Second repeat | Combined score |
| --- | ---: | ---: | ---: | ---: | ---: |
| GSM8K test | 12 | 2 | 12/12 | 12/12 | 24/24 (100%) |
| IFEval | 12 | 2 | 12/12 | 12/12 | 24/24 (100%) |

IFEval's main score is **strict prompt-level accuracy**. All 38 instruction checks
across both repeats also passed. Loose prompt and instruction metrics were identical.
These are small integration samples, not full benchmark scores. The two repeats
cover 24 distinct questions in total and are correlated observations.

During the subsequent expanded run, a Windows Python stdin encoding issue was
found and fixed. All 24 IFEval responses from this original smoke were regraded
with explicit UTF-8 transport and still passed 24/24. The corrected grading
version is `4640611d46d51ae3aa422885fe7919f96856e62d19b372398a763f3504ebb1dd`,
saved in `runs/opensource-20261002-ifeval/report.utf8.json`. Original answers and
earlier grading records were retained; no target calls were repeated.

## What was verified

- 48 unique one-eval session IDs and 48 unique Codex thread IDs.
- Each artifact contains exactly the input question and its own answer. The adapter
  passed no reference answer to the target. No tool events were observed.
- Every attempt began with an empty owned temporary directory, outside the repository,
  and launched a new ephemeral CLI process. Tool features, project instructions,
  plugins and memory were disabled.
- All 48 artifacts were completed on attempt 1. The two repeats produced different
  answer text for 10/12 GSM8K questions and 12/12 IFEval questions; scores stayed stable.
- Blank-output negative controls scored zero for all 24 selected questions. This
  checks that the graders can reject missing answers; it does not validate every
  possible incorrect answer or semantic failure.
- Re-running `resume` and `grade` left all attempt, artifact and grade-record bytes
  unchanged, with 24 completed executions and 24 scores in each run.
- 72 automated tests passed; TypeScript checking, build and `git diff --check` passed.

The local call history supports session separation at the adapter boundary. Hidden
state on the remote service cannot be independently verified. These runs did not
exercise tool-using agents, multi-turn dialogue, workflow side effects, HTTP targets,
LLM judging or multi-model judging; those need separate integration evidence.

## Dataset and grader provenance

The deterministic seed is `one-eval-smoke-20261002`. Every original row is ranked
by SHA-256 of `seed:dataset:zero-based-index`; the first 12 are selected and restored
to source order. Selection occurred before any target outputs. No cases were removed.

- **GSM8K:** [OpenAI repository](https://github.com/openai/grade-school-math), commit
  `3101c7d5072418e28b9008a6636bde82a006892c`, 1,319 test rows, MIT license.
  Source indices: `70, 177, 244, 484, 489, 589, 623, 642, 786, 819, 866, 1171`.
  The input appends a request for reasoning and a final `#### <number>` line.
  Scoring matches the official first-marker extraction, comma removal and exact
  string comparison; alternate numeric formatting can score zero.
- **IFEval:** [Google Research source](https://github.com/google-research/google-research/tree/e6890f85757dd84e27ca6df2dd30651dafad28e0/instruction_following_eval),
  commit `e6890f85757dd84e27ca6df2dd30651dafad28e0`, 541 rows.
  Keys: `1137, 1251, 1691, 1837, 2041, 2078, 2100, 2195, 2341, 2449, 2765, 3166`.
  Original prompts are unchanged. The wrapper directly calls the pinned official
  strict and loose evaluator. Data is CC BY 4.0; source is Apache-2.0 under the
  [pinned repository notice](https://github.com/google-research/google-research/blob/e6890f85757dd84e27ca6df2dd30651dafad28e0/README.md).
  Credit: Jeffrey Zhou and the IFEval/Google Research authors, *Instruction-Following
  Evaluation for Large Language Models* (2023).

IFEval only grades its listed machine-checkable constraints. Passing does not
establish factual correctness or full semantic compliance. For example, selected
key 2078 asks for exactly one bullet while also referring to a few bullet points;
the official checker enforces one bullet. This source inconsistency was retained.
Public benchmark training contamination was not investigated.

## Runtime observations

| Dataset | Median seconds/call | P95 seconds/call | Input tokens | Cached input tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| GSM8K | 7.570 | 11.326 | 358,000 | 249,728 | 3,743 |
| IFEval | 10.214 | 32.948 | 331,182 | 275,712 | 10,715 |

Latency includes local process startup, target execution and cleanup. Medians use
the upper middle observation. Input tokens include the CLI's own system context;
cached tokens are a subset of input tokens, not extra tokens. Prompt-cache usage
does not imply reused response outputs or conversation history. Token totals exclude
two setup probes. No monetary cost was inferred from account usage.

## Saved evidence and reproduction

Run identities:

- GSM8K: `48faf288-9fa1-4a4e-851e-4734c8a7dbc4`
- IFEval: `be04dc3a-8323-4f52-a615-3a66f8263507`

The local checkout retains all raw answers, CLI events, token counts, reference
data, individual grades and frozen source snapshots:

- `runs/opensource-20261002-gsm8k/report.json`
- `runs/opensource-20261002-ifeval/report.json`
- `results/open-source-smoke-20261002.json`
- `results/open-source-smoke-20261002-checks.json`
- `data/open-source-smoke-20261002-v1/provenance.json`

Generated data and results remain gitignored. Tracked preparation scripts, pinned
source commits and [reproduction instructions](../examples/benchmarks/README.md)
allow another local run. The current adapter pins CLI 0.144.6 and requests model
alias `gpt-5.6-sol`; the remote model behind an alias may change over time.
