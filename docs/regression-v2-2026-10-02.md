# Expanded reliability regression, 2026-10-02

This round expands adversarial execution, persistence, grading lifecycle, numeric
aggregation, and live acceptance. It keeps one-eval as an agent-facing CLI/library
in its independent checkout. Existing benchmark outputs are retained.

## Reproduced problems and fixes

New failing regression tests were run before each fix. The local evidence is under
`results/regression-v2-20261002/`, with grading details in
`results/grading-adversarial-audit-20261002.json`.

| Area | Reproduced behavior | Change |
| --- | --- | --- |
| Provider isolation | Declared-stateless target reused one local provider instance across cases | A fresh instance per trial attempt; turns within a trial retain their own instance |
| Provider failures | Structured errors lost HTTP status and nested causes | Preserve status/code/cause without mutating provider errors |
| Usage accounting | Partially metered turns appeared to have complete totals; overflow and prototype-like keys corrupted summaries | Explicit coverage/overflow, finite validation, safe metric dictionaries, retained per-call data |
| Execution entry | Rehashed invalid plans reached target calls; damaged evidence was accepted during resume | Validate plan schema, reservation relationships, canonical execution identity, output digests, and lifecycle consistency before target calls |
| Duplicate operations | Consistently renamed evidence caused an already completed business operation to execute again | Reject noncanonical IDs at execution/recovery entry; imported collections remain grade/report inputs |
| Grading timeout | Cleanup ran while an aborted judge was still active; another process could retry and duplicate work | Stop admissions on timeout, defer cleanup until settlement, quarantine active lifecycles, and retain the owning process ID |
| Grading evidence | Corrupt case links, reservations, versions, costs, bounds, and blocked state were accepted | Validate persisted schemas and execution-to-grade relationships |
| Report integrity | Lost newer reservations, duplicate artifacts, or conflicting lifecycle evidence could leave a report complete | Audit retained start reservations and identities; incomplete or invalid evidence prevents complete reports |
| Aggregation | Finite extreme weights produced nonfinite or inaccurate results; blocked comparisons exposed per-case deltas | Stable weighted means and no comparison deltas until both reports are complete |
| Diagnostics | Unusual thrown objects caused the error classifier to throw again | Guard property/string extraction so failure persistence survives malformed errors |

## Deterministic regression scope

- Existing offline, configuration, CLI, HTTP, execution, grading, benchmark wrapper,
  workflow oracle, preflight, report, comparison, and storage tests remain included.
- Stress case: 40 distinct Unicode/quoted/multiline inputs, three repeats,
  concurrency 12, two target turns each: **120 trials and 240 target calls**.
- Each stress output receives two judge instances with two repeats: **480 grades**.
- Resume and regrade produce no extra calls; completed artifact/grade hashes stay
  unchanged. These stress providers are deterministic local fixtures, with no live
  model calls.
- Additional lifecycle tests exercise noncooperative calls, slow cleanup,
  concurrent systemic failures, interrupted reservations, explicit retries,
  attempt caps, and six seeded mixed-failure scheduling scenarios.

## Live acceptance scope

The separate [acceptance-v2 harness](../examples/acceptance-v2/README.md) freezes
inputs and expected labels before calls. Expected labels and rationales are kept
out of judge inputs. The fixtures are agent-authored, inspectable test expectations;
they are not human expert annotations or a broad measurement of judge accuracy.

- 24 fixtures, two requested models (`gpt-5.6-sol`, `gpt-5.6-luna`), two repeats:
  **96 real judge calls**. All 96 matched the predefined score/status, with no
  execution errors, missing judgments, or observed cross-model disagreements.
- Scope includes partial credit, contradictory answers, irrelevant verbosity,
  Unicode normalization, JSON structure and escaped characters, candidate prompt
  injection, missing rules, missing external evidence, explicit grader abstention,
  appropriate refusal, over-refusal, and empty saved outputs.
- Native stateful sessions and simulated-user conversations are audited separately
  using unique canaries, raw requests, thread identities, cleanup evidence, and
  independent deterministic checks.

The completed live acceptance used **146 real model invocations**, with zero
execution errors and no retries: 96 judge calls, 40 target turns, and 10 simulator
calls. The live call budget was 180. Detailed results are in the
[live acceptance report](../examples/acceptance-v2/report-2026-10-02.md) and
`results/acceptance-v2-20261002/summary.json`.

| Live phase | Result | Evidence |
| --- | --- | --- |
| Repeated judging | 96/96 matched fixed expectations | 84 scored, 4 abstained, 8 insufficient-evidence judgments; labels withheld |
| Native stateful HTTP | 15/15 passed, 30 target turns | Three overlapping real calls, 15 independent threads/canaries, 6/6 blank probes |
| Real simulated users | 4/4 passed, 10 target turns and 10 simulator calls | Four independent threads/canaries, all four ended via simulator stop |
| Lifecycle and transport audit | 18/18 checks passed | 19/19 session directories cleaned, no observed foreign canaries, raw latest-message transport verified |

## Historical compatibility

The current report builder reprocessed copies of nine historical evaluation or
calibration groups. Scores, coverage, and calibration judgments remained the same.
All **2,711 historical files** retained their original SHA-256 digests before and
after the audit. Original run paths were not opened for writes, including locks.

| Existing expanded benchmark | Recomputed score | Status |
| --- | ---: | --- |
| GSM8K | 95% | Unchanged |
| IFEval strict | 92.5% | Unchanged |
| BFCL-adapted function generation | 93.75% | Unchanged |
| Context challenge | 87.5% | Unchanged |
| MCP workflow | 100% | Unchanged |

This checks compatibility with saved evidence. It makes no new target or judge
calls for the old public benchmark cases. The audit is saved in
`results/regression-v2-20261002/history-audit.json`.

## Final verification

Two consecutive complete suites after the fixes each passed **180/180** tests,
with zero failures, skipped tests, or cancellations. The earlier baseline had 129
tests, so this round adds 51. Type checking and the TypeScript build passed.
The second suite repeats the concurrency, timeout, and real child-process
regressions as part of the same full test command.

Final machine-readable verification is saved in
`results/regression-v2-20261002/final-verification.json`, alongside
`full-suite-final.txt`, `full-suite-repeat.txt`, `typecheck.txt`, and `build.txt`.
The final built report code also reproduced the new native and simulated reports
from copied saved evidence, with unchanged scores and coverage.

Live acceptance phases retained their own starting core-source hashes while
hardening continued. They do not represent 146 calls against one frozen final
core version. Later fixes are verified by the final regression suites and saved
report reconstruction; final source hashes and differences from the live-phase
snapshots are included in the verification JSON.

The first exploratory full-suite log is also retained: 169/170 passed while the
new canonical-trial-identity regression was still being fixed. It is not the final
acceptance result. The fixed execution suite subsequently passed all 25 tests.

## Interpretation and remaining boundaries

This is evidence for the tested runner and integration contracts. Both live judge
models use the authenticated Codex CLI integration; it does not establish
cross-vendor API coverage. Each third-party stateful adapter still needs its own
isolation acceptance checks.

In-process JavaScript cannot be forcibly cancelled by a timeout. The runner stops
admissions, records the unknown outcome, and prevents unsafe retries while known
work remains active. Cost arriving after the bounded grace period remains unknown
in the immutable failed record. Observed-cost limits are not hard billing caps.

Saved hashes detect corruption and changed evidence; they are not signatures
against an attacker able to rewrite every file and digest. Tests of damaged
records verify fail-closed handling of observable inconsistencies.
