# Diagnostics, limits, and report analysis

These controls support external agents operating one-eval through JSON commands.
See [preflight.md](preflight.md) for separate execution probes and grader calibration.

## Failure information

Failed execution artifacts and grading records include `diagnostic` with `code`,
`phase`, `message`, and advisory `retryable`. Available provider status/code and a
bounded cause chain are retained. `cleanupDiagnostic` preserves cleanup failures
without replacing the original error. Existing error strings remain readable.

Codes distinguish authentication, permission, rate limiting, unavailable service,
timeout, network, configuration, malformed output, output limits, process exit,
cleanup, interrupted grading, and unknown failures. Common credential patterns in
diagnostic messages are redacted; this is best effort. Saved answers and raw grader
outputs remain evaluation data and can contain sensitive user-provided content.

`retryable` never overrides target `retrySafe`, blocked environment state, or
explicit retry requirements. Authentication/configuration failures stop new
admissions. Already admitted work may finish and must retain its evidence.

LLM grades retain duration, bounded raw output, and available provider token/cost
data. Malformed responses remain inspectable. Missing usage stays unknown.
Command grader costs are unknown.

Ordinary provider targets now receive a new local provider instance for each trial
attempt. Turns inside that trial share the instance; other cases and repeats do
not. This prevents provider-local conversation state from crossing trials. The
remote service still needs an accurate stateless contract or a managed adapter.

For noncooperative LLM judges, a timeout stops new admissions immediately. Cleanup
waits for the actual request to settle. A bounded grace period captures usage from
promptly settling requests; usage arriving after that period remains unknown in
the immutable result. Pending requests and cleanup quarantine same-process retries.
The saved owning process ID also blocks retry from another live process, including
another grading version on the same run. Once the owner exits, explicit retry can
proceed subject to the retained attempt and cost limits. An explicit retry cannot
make an unsettled request safe to repeat.

A durable grading reservation is written before invoking a judge. An interrupted
reservation without a result becomes an explicit interrupted grading error on
reconciliation and requires explicit retry. It still consumes an attempt and has
unknown cost. Finished historical records are preserved.

Manifest hashes are checked together with schema, bounds, record filenames,
case/repeat identities, execution-to-grade links, and reservation evidence.
Malformed or contradictory evidence cannot produce a complete report. Execution
resume and recovery additionally require the runner's canonical trial identity
and a valid completed-output digest before making any target calls. Historical
imported output collections remain usable for grading and reporting.

## Attempt and start-rate controls

Execution accepts optional `maxAttempts` and `minIntervalMs`:

```json
{
  "repeats": 3,
  "concurrency": 4,
  "timeoutMs": 60000,
  "maxAttempts": 920,
  "minIntervalMs": 250
}
```

For 300 cases repeated three times, the planned denominator stays 900. This example
permits 920 total trial attempts, including failures and retries. A trial may
contain multiple target turns, simulator calls, and tool calls. This cap does not
represent a model-token, tool-call, or monetary budget.

`minIntervalMs` spaces trial admissions across workers within one invocation.
It does not rate-limit internal tool/model calls or other processes. Zero disables
spacing; concurrency remains a separate limit.

Grading accepts these same optional fields at the configuration top level. Each
judge/repeat invocation is an attempt; all retained attempts for that grading
version, including interrupted reservations and retries, count toward the cap.
Completed slots are skipped. Start spacing applies across the configured judges.

At a cap, new admissions stop. `limitReached` and `limitReason` explain why, missing
slots remain visible, and an incomplete CLI operation exits nonzero. Budget
exhaustion alone does not mean external state is corrupted.

Limits are part of frozen configuration. Allow room for planned work and retries.
Changing execution limits requires a new execution plan; changing grading limits
creates a new grading version. Never edit manifests to reset counters. These are
per-run/version limits, not an account-wide budget.

## Observed grading cost threshold

Grading also accepts positive `maxCost`, in the provider's reported cost units.
Use providers with known, comparable cost reporting. New admissions stop once
observed cumulative cost reaches the threshold. Already admitted requests can take
the total above it; concurrency 1 minimizes this overshoot. This is an observed
threshold, not a strict billing cap.

If an attempted request has unknown cost, further cost-limited grading stops with
an explanation. Command graders cannot satisfy this accounting contract; use
attempt limits. Historical records with missing cost remain unknown. Token counts
are not converted to money using guessed prices.

## Reports and comparisons

The original overall-score and missing-value rules are unchanged. `analysis` adds:

- Groups from `case.metadata.category` and `case.metadata.tags`, using case weights.
  Incomplete groups remain `null`. Tags overlap; do not average group totals into
  another overall score.
- Case variability and differences between judge means. Disagreement does not
  identify the correct judge.
- First-attempt completions divided by planned trials, retry/failed attempt counts,
  and diagnostic categories. Successful retries do not erase earlier failures.
- Known target-call and grading usage, with missing-record counts. Individual call
  records prevent one metered turn from hiding an unmetered turn. An attempt with
  no call evidence contributes an unknown placeholder. Unreported failed requests
  and internal tool calls cannot be reconstructed. Simulator usage is excluded
  from these target totals and remains available in raw artifacts.

Raw multi-turn summaries omit total cost or a token field when any constituent
call omits it. `costCoverage` explains incomplete cost reporting. Overflow is
explicitly flagged by `usageOverflow`; report usage totals use an `overflow` flag
instead of publishing an infinite numeric total. Per-call evidence remains
available. Metric names such as `__proto__` are ordinary data keys.

Weighted aggregation rescales finite positive weights before summation to avoid
overflow. Blocked or incompatible comparisons expose no aggregate or per-case
score delta.

```sh
one-eval report runs/candidate --grading-version HASH
one-eval compare runs/baseline --against runs/candidate
```

For multiple grading versions use `--baseline-grading-version` and
`--candidate-grading-version`. Comparability requires matching case IDs, inputs,
references, conversations, metadata, weights, complete coverage, and grading
version. Metadata is included because graders can use it as rubric/expected state.
Policy or case changes yield `comparable: false`, aggregate `delta: null`, and a
nonzero CLI status; the original scores remain visible.

Deltas are descriptive, not significance tests. Different repeat counts remain
correlated observations. Compare finished runs: reports are sequential snapshots.
Deployed model/service versions outside tracked files need separate provenance.
