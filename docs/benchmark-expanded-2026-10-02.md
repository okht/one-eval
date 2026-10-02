# Expanded evaluation report — 2026-10-02

one-eval completed **256 distinct cases, two repeats per case, and 512 trial
slots** using `gpt-5.6-sol` through authenticated Codex CLI 0.144.6. Multi-turn
cases brought the successful model-turn count to **540**. All final executions
and grades are complete; 12 earlier execution failures were retained and each
retried once successfully. Completed answers were never rerun to improve scores.

This expands the [initial 24-question smoke test](benchmark-smoke-2026-10-02.md)
with larger public samples, function-call generation, context challenges, and an
agent that actually calls tools against a local synthetic order database.

## Results

| Suite | Distinct cases | Trials | First repeat | Second repeat | Main score | Cases passing both repeats |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GSM8K test | 100 | 200 | 96/100 | 94/100 | **190/200 (95%)** | 94/100 |
| IFEval, strict prompt | 100 | 200 | 92/100 | 93/100 | **185/200 (92.5%)** | 91/100 |
| BFCL, selected JSON adaptation | 40 | 80 | 38/40 | 37/40 | **75/80 (93.75%)** | 37/40 |
| Synthetic context, exact full dialogue | 8 | 16 | 7/8 | 7/8 | **14/16 (87.5%)** | 6/8 |
| Synthetic MCP order workflow | 8 | 16 | 8/8 | 8/8 | **16/16 (100%)** | 8/8 |

Keep these scores separate: the suites measure different properties. Repeats are
correlated observations, and this report does not estimate general model quality
or an official leaderboard rank.

IFEval contains 159 instruction checks per repeat. Strict checks passed **302/318**;
loose checks passed **309/318**, with **192/200 (96%)** loose prompt accuracy.
The selected cases cover all **25 instruction types and nine families** in the
pinned source. Six types have only one or two selected checks, so coverage breadth
does not establish reliable performance for every type.

BFCL category results were **25/30 simple Python**, **30/30 multiple-function
selection**, and **20/20 irrelevant-function cases**. All 80 outputs satisfied the
JSON protocol. These cases generate function descriptions and arguments; their
functions are not executed. Actual tool execution is covered separately below.

## Context and actual tool execution

The context suite checks own-case recall, distractors, overwriting, clearing, and
interleaved blank cases. It ran 38 model turns across 16 trials:

- **16/16 final values were correct**, including updated, cleared, and unknown values.
- **6/6 blank probes returned `UNKNOWN`** after earlier cases had supplied tokens.
- **No foreign fixture token was observed** in any trial's replies.
- Exact replies passed **35/38 turn checks**. `memory-1` repeat 2 returned `STORED.`
  instead of `STORED`; `memory-overwrite` repeat 1 added periods to `STORED` and
  `UPDATED`. These formatting differences explain both failed full-dialogue trials.

Thus the 87.5% score measures the complete exact-output protocol. The observed
recall and blank-probe results support visible conversation separation for this
adapter and these cases. They cannot prove the absence of all hidden server memory.

The workflow suite ran **22 model turns and 33 actual MCP tool calls**. Its eight
scenarios cover order-ID clarification, already-refunded idempotency, unpaid and
shipped refusals, a paid refund with a follow-up status read, a query-only request,
an eligible delivered refund, and an expired return window.

All 16 workflow trials passed an independent full-state oracle and tool-audit
checks. Evidence includes actual arguments/results, receipt IDs, exact refund
reasons, and the complete final database. Checks reject unrelated mutations,
refunds without authorization, and action before required clarification. Each
trial starts with a fresh synthetic database; its turns share that database.
No real orders, customer data, or payments were used.

Both synthetic suites use **transcript replay**: every turn starts a fresh Codex
thread and receives only that trial's accumulated user/assistant transcript. They
do not exercise native resumed remote sessions. Process cleanup was checked after
the live runs; automated abort tests also verify termination of the owned process
tree, including its MCP server.

## Failures worth inspecting

All scores retain the configured official rules or documented adaptations.
The following annotations explain failures without changing scores or removing cases.
Full prompts, references, responses, reasons, and artifact paths are in the
[combined machine report](../results/expanded-20261002.json).

| Case | Observation | Interpretation |
| --- | --- | --- |
| `gsm8k-1139`, both repeats | Correct numeric value emitted as `#### 1.00`; reference is `#### 1`. | Official numeric-string matching rejects equivalent formatting. |
| `gsm8k-161`, repeat 2 | Answer excludes starfish; reference includes them in the total fish count. | Wording/taxonomy discrepancy affects the result. |
| `gsm8k-515`, both repeats | Interprets a price as per pack; reference uses per bag. | Unit interpretation merits manual review. |
| `gsm8k-675`, both repeats | Answer 25; reference 33, with an ambiguous growth description and a questionable intermediate jump in its rationale. | Keep the official score and flag reference review; no replacement answer is asserted. |
| `ifeval-1377`, repeat 1 | Returns a clarification instead of the required five-part response. | A substantive instruction-following failure; the other repeat passes. |
| `ifeval-1627`, both repeats | Required verbatim prefix contains a comma, alongside a no-comma requirement. | Conflicting constraints in the selected case. |
| `ifeval-1837`, repeat 1 | Numbered lyrics produce extra sentence boundaries in the official tokenizer. | Sentence-count scoring is sensitive to formatting. |
| `ifeval-2571`, both repeats | Fails the requested uppercase constraint. | A direct machine-checkable constraint failure. |
| `bfcl-simple_python_355`, both repeats | Uses `Beef Lasagna Recipe`; accepted argument is `Beef Lasagna`. | Canonical argument matching is narrower than plausible wording. |
| `bfcl-simple_python_356`, repeat 2 | Uses preparation time 29 for a request under 30; accepted value is 30. | Boundary interpretation differs from the reference. |
| `bfcl-simple_python_367`, both repeats | Uses recipe type `brownies`; reference expects `dessert`. | Incorrect abstraction level for the category parameter. |

## Reliability and the bug fixed during this run

**500/512 trials completed on their first attempt.** The remaining 12 were execution
errors: two GSM8K, six IFEval, and four BFCL. Each succeeded on its first retry.
The original CLI adapter saved the generic error `Codex target: CLI reported error`,
so their underlying causes cannot be established from the retained errors. Better
CLI error detail remains a diagnostic improvement. Do not infer a rate-limit or
network cause from these records.

The expanded run exposed a separate **Windows Python encoding bug**. Node sent
UTF-8 JSON, while Python's default stdin decoding could use GBK. Two IFEval grade
attempts raised JSON parsing errors; other Unicode could be silently corrupted.
Both the IFEval and BFCL Python entry points now explicitly configure UTF-8 stdin,
stdout, and stderr. Scoring rules were unchanged.

All **200 saved IFEval and 80 saved BFCL answers** were regraded under new grading
versions, retaining earlier records. The original 24-answer IFEval smoke was also
regraded and remains 24/24. No additional target calls were made for regrading.
Regression tests force a GBK environment and independently check Unicode decoding,
including Chinese, emoji, quotes, and newlines.

Final local verification: **91 automated tests passed, zero failed or skipped**;
TypeScript checking and build passed. Test evidence covers local contracts and
fixtures; it does not establish the quality of a real LLM judge.

The combined audit found **524 unique one-eval attempt session IDs** (512 final
attempts plus 12 failed attempts) and **540 distinct successful Codex thread IDs**.
It checked planned user messages, within-case transcripts, assistant-turn counts,
MCP evidence, complete reports, and absence of retries for completed answers.
Some failed CLI invocations did not preserve thread or usage information. Therefore
540 is the successful model-turn count, excluding failed invocations and setup probes.

## Dataset and grader provenance

Selection occurred before model outputs. No selected cases were removed.

| Source | Pinned revision | Sampling and grading |
| --- | --- | --- |
| [GSM8K](https://github.com/openai/grade-school-math) | `3101c7d5072418e28b9008a6636bde82a006892c` | 100 of 1,319 test rows; original first-marker extraction, comma removal, and exact string comparison. MIT. |
| [IFEval](https://github.com/google-research/google-research/tree/e6890f85757dd84e27ca6df2dd30651dafad28e0/instruction_following_eval) | `e6890f85757dd84e27ca6df2dd30651dafad28e0` | 100 of 541 prompts, unchanged; pinned official strict/loose evaluation. Data CC BY 4.0, code Apache-2.0. |
| [BFCL](https://github.com/ShishirPatil/gorilla/tree/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000/berkeley-function-call-leaderboard) | `f7cf7359b7ac615a0b294831c5ba2bc95ee4a000` | 15/400 simple Python, 15/200 multiple, 10/240 irrelevance; official selected checking code with a JSON prompt adaptation and strict protocol gate. Apache-2.0. |

IFEval attribution: Jeffrey Zhou and the IFEval/Google Research authors,
*Instruction-Following Evaluation for Large Language Models* (2023). See the
[pinned repository license notice](https://github.com/google-research/google-research/blob/e6890f85757dd84e27ca6df2dd30651dafad28e0/README.md).

GSM8K and IFEval rank rows by SHA-256 of
`one-eval-smoke-20261002:dataset:zero-based-index`, take the first 100, and restore
source order. They include the original 12 selected questions per dataset.
BFCL ranks within categories using seed `one-eval-expanded-bfcl-20261002` and
source IDs. The [BFCL integration notes](../examples/benchmarks/bfcl/README.md)
document checker reuse and adaptation boundaries. Synthetic sources and fixed
oracles live under [isolation](../examples/benchmarks/isolation/README.md) and
[agent-workflow](../examples/benchmarks/agent-workflow/README.md).

## Evidence and reproduction

Use the [expanded reproduction instructions](../examples/benchmarks/expanded-README.md).
The local checkout retains inputs, source provenance, frozen execution/grading
snapshots, raw answers, CLI events, failed attempts, tool audits, and final reports.
Generated data and run artifacts are Git-ignored local evidence.

| Suite | Final report | Final grading version |
| --- | --- | --- |
| GSM8K | [report.json](../runs/expanded-20261002-gsm8k/report.json) | `821b33bb552d1765911e74cf8c00aea2d95dbf7c38cd3d75331129333b883cf0` |
| IFEval | [report.json](../runs/expanded-20261002-ifeval/report.json) | `9a2998efc97e02586cfd7cca1e815730d506c1a7ae61d77f931c852ce66f893b` |
| BFCL | [report.json](../runs/expanded-20261002-bfcl/report.json) | `440ff549ec4aae395071c67908891adb9fa5614b6534c65a0139116bcf2a14e1` |
| Context | [report.json](../runs/expanded-20261002-isolation/report.json) | `aa0c3ba13a7a1f52dd7b96ea85bbdd70d8443a43ba7155274b1cce0776f845b9` |
| Workflow | [report.json](../runs/expanded-20261002-workflow/report.json) | `742eb162d395979ebaa06eceb9a3d835bdad0df54ee21b5d442026d4101ec182` |

These results establish an end-to-end path for dataset preparation, isolated
execution, repeats, execution-error recovery, saved-answer regrading, deterministic
scoring, tool/state evidence, and coverage-aware reporting in the tested setup.
They leave live multi-model LLM judging, arbitrary HTTP targets, locally hosted
models, native stateful-session adapters, and full external agent benchmarks
unverified. Public-dataset training contamination was not investigated. The hosted
model implementation is not frozen by local source snapshots.
