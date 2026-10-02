# Reliability improvements and live acceptance — 2026-10-02

one-eval now includes independent execution probes, grader calibration,
structured diagnostics, bounded execution/grading, and reusable report analysis.
The expanded public benchmark answers were preserved and reused where appropriate.
No GUI was added. All work remains in the independent one-eval checkout.

## Delivered behavior

| Capability | What changed | Evidence |
| --- | --- | --- |
| Execution preflight | `probe` runs a small real subset through preparation, isolation verification, execution, and cleanup. It records the original and probe plan hashes and states the remaining isolation assumptions. | Focused lifecycle tests; built CLI offline probe 2/2 complete. |
| Independent grader calibration | `calibrate` imports known answers, hides expected score labels/bands, and checks every judge/repeat. Positive and negative anchors are mandatory. An always-full-marks grader fails. | Positive/negative/error/missing-evidence tests; built CLI offline calibration 24/24; real-model results below. |
| Structured failure diagnostics | Stable code, phase, sanitized message, cause/status, and advisory retryability. Original and cleanup failures survive together. CLI capacity errors retain their underlying message. | Error/cause/redaction tests; actual capacity failures retained in live HTTP testing. |
| Runtime accounting | Attempt caps include errors and retries; admissions can be spaced across workers. Grading retains known usage, duration, and bounded raw outputs. Durable grading reservations expose requests interrupted before result persistence. | Concurrent caps, crash reservations, interrupted retries, start spacing, malformed responses, unknown cost, and observed-cost tests. |
| Reusable analysis | Category/tag groups, repeat variability, judge disagreement, first-attempt/retry statistics, and known/missing usage are part of the core report. | Report tests and successful read of historical GSM8K evidence: score remains 0.95, earlier two failures remain visible. |
| Run comparison | `compare` checks case definitions, metadata, weights, coverage, and grading version before emitting score deltas. | Weighted regression test, changed-input/metadata rejection, built CLI same-run delta 0. |

Execution and grading remain independent. A user can generate answers before
choosing a scoring prompt, then calibrate and grade later without invoking the
target again. Every normal trial still verifies isolation; a successful probe
does not bypass the lifecycle.

## Real LLM grading

Two model identifiers, `gpt-5.6-sol` and `gpt-5.6-luna`, were called through the
authenticated native Codex CLI 0.144.6. Every judge call used a fresh ephemeral
thread, with project instructions, tools, plugins, memory and web search disabled.
These are real model responses, separate from the deterministic automated tests.

| Acceptance set | Fixtures | Models | Repeats/model | Result |
| --- | ---: | ---: | ---: | --- |
| Exact-rule and protocol checks | 12 | 2 | 2 | **48/48 individual results matched**; no errors or missing results. |
| Semantic rubric checks | 3 | 2 | 2 | **12/12 individual results matched**; no errors or missing results. |

The exact-rule fixtures include correct/wrong answers, empty output, Chinese and
emoji, prompt-injection attempts inside candidate text, missing scoring rules,
format distinctions, and two previously saved GSM8K answers. Of the 48 results,
44 returned scores and four correctly returned `insufficient_evidence`.

The semantic fixture uses an explicit synthetic customer-service policy and two
independently scored criteria. Paraphrasing both requirements should score 1;
contradicting both should score 0; meeting the cancellation requirement while
omitting the refund explanation should score 0.5. Both models matched these
precommitted expectations in both repeats.

These fixtures were authored and reviewed by the evaluation agent before model
calls. They are not an expert-human-labeled benchmark. Both models belong to the
same provider family. The results verify these small scoring contracts and live
integration; they do not establish general judge accuracy, unbiased judgment, or
cross-vendor independence. CLI event streams record the requested model and do
not supply a second independent server model identifier.

## Native stateful HTTP integration

A loopback HTTP application owned server-side sessions backed by actual Codex
native threads. One-eval sent only the latest user message; later turns used
`codex exec resume` on the same thread. This exercises native session continuation
in addition to the transcript-replay tests from the expanded benchmark.

- **Six scenarios x two repeats = 12 trials**, all completed and passed exact
  dialogue grading after error recovery.
- **22 successful turns in the final trial attempts**, including ten native-resume
  turns; **12 distinct final threads**, with no cross-trial thread reuse.
- Recall, overwrite, clearing, and **6/6 blank probes returning `UNKNOWN`** passed.
- Two initial attempts failed with the actual service message
  `Selected model is at capacity. Please try a different model.` Each failed trial
  was retried once using the same model and rules. Successful trials were skipped.
- **14/14 attempted service sessions were cleaned up**. Owned working directories
  were removed and revoked session endpoints returned 404. Codex's persisted
  native history remains audit evidence; global history deletion is not claimed.

There were 24 successful native turns across all attempts: two belonged to failed
attempts before the capacity errors. Including those errors, 60 grading calls,
and two readiness probes, the total real-model invocation count was **88**.

This is a local, real-model-backed HTTP integration. It does not establish
isolation for arbitrary production APIs, account-level memory, external databases,
or locally hosted model implementations.

## Verification and review fixes

**129 automated tests passed, zero failed or skipped.** TypeScript checking and
build passed. The built CLI also completed the offline probe/calibration and read
historical benchmark results without loading or rerunning targets.

Independent review caught and corrected four issues during implementation:

1. Case metadata now participates in comparison compatibility because graders
   may depend on its rubric or expected business state.
2. Wrapped authentication errors now block execution based on the structured
   underlying cause instead of only matching the outer message.
3. Execution deadlines classify as timeouts.
4. Usage analysis reads individual target calls. One known-cost turn cannot hide
   another turn with missing usage; failed attempts without call evidence remain
   unknown placeholders.

Historical evidence and failure records were preserved. No commits or remote
publication were performed as part of this improvement round.

## Remaining boundaries

- Provider statelessness remains a declared contract; module verification is only
  as strong as the adapter's actual checks. Preflight explicitly reports this scope.
- `maxAttempts` limits trial or judge attempts, not every underlying model/tool
  call. Grading `maxCost` stops future admissions after observed cost and can be
  exceeded by already admitted requests. Missing cost stops further cost-limited
  grading. The Codex acceptance has token evidence, with no invented monetary cost.
- Limits are frozen with configuration. Raising them currently needs a new
  execution plan or grading version; no account-wide budget manager is provided.
- Script/module adapters remain trusted local code. This round does not add a
  multi-tenant execution sandbox or universal remote cancellation.
- The next broader validation needs external production-style API adapters,
  locally hosted models, cross-vendor judges, and expert-reviewed domain rubrics.

## Evidence and instructions

- [Preflight and calibration guide](preflight.md)
- [Diagnostics, budgets and reporting guide](reliability.md)
- [Real acceptance reproduction](../examples/acceptance/README.md)
- [Acceptance summary](../results/acceptance-20261002/summary.json)
- [Exact-rule calibration](../results/acceptance-20261002/calibration.json)
- [Semantic calibration](../results/acceptance-20261002/semantic-calibration.json)
- [Core verification and source hashes](../results/hardening-20261002/verification.json)
- [Historical GSM8K through the new report](../results/hardening-20261002/legacy-report.json)

Raw run directories are `runs/acceptance-20261002-calibration`,
`runs/acceptance-20261002-semantic`, and
`runs/acceptance-20261002-native`. Generated evidence is retained locally and
Git-ignored. Core source hashes identify the reviewed implementation, not a frozen
remote model deployment.
