# Agent integration guide

one-eval is designed to be called by an external agent through a process tool or the TypeScript library. MCP is not required. The external agent owns interpreting the user's goals, preparing configuration and source files, and explaining the results.

## Recommended sequence

1. Call `schema` to inspect the current execution and grading JSON Schemas. Convert the user's evaluation set to cases in JSON or JSONL. Preserve original row IDs and source locations in `metadata`. Do not silently invent missing facts.
2. Select a stateless provider or implement a managed target module. Establish the required session and business-state reset contract. Use a test environment for targets that make changes.
3. Use `init <empty-directory> --template offline|openai-compatible|http|managed` as a starting point, or write an execution configuration and run `validate`. Validation checks configuration and source files; target preparation and isolation verification happen during execution.
   Use `probe <config> --out <new-directory> --cases 2` for a bounded real check. Its `ok` result includes verified scope and remaining isolation assumptions. Probe operations can have the same side effects as normal target calls.
4. Run the plan into a new directory with `--preflight <probe-directory>/admission.json`. A failed probe or invalid receipt prevents formal execution. Read the JSON summary and retained artifacts, including unsuccessful attempts. A nonzero exit code can accompany a useful structured summary.
5. Prepare a separate grading configuration. Use the user's supplied policy or explicit agent-authored prompts/scripts. Keep the policy source clear to the user.
   `validate <judges.json> --grading` checks this phase independently. Use `calibrate <known-answers.json> --config <judges.json> --out <new-directory>` to check each judge/repeat against known positive and negative fixtures without invoking the target.
6. Run `grade` with `--calibration <calibration-directory>/admission.json`. This operation can happen later, using only saved outputs, messages, and metadata. Record the returned `gradingVersion`.
7. Run `report` with the selected grading version. Report execution and grading coverage alongside scores. A missing score is not zero and must not vanish from the denominator.

## Process interface

```sh
node dist/cli.js schema
node dist/cli.js init <empty-directory> --template offline
node dist/cli.js validate <execution-config.json>
node dist/cli.js validate <judges.json> --grading
node dist/cli.js probe <execution-config.json> --out <new-probe-directory> --cases 2
node dist/cli.js calibrate <fixtures.json> --config <judges.json> --out <new-calibration-directory>
node dist/cli.js run <execution-config.json> --out <new-run-directory> --preflight <new-probe-directory>/admission.json
node dist/cli.js resume <run-directory>
node dist/cli.js resume <run-directory> --retry-errors
node dist/cli.js recover <run-directory>
node dist/cli.js grade <run-directory> --config <judges.json> --calibration <new-calibration-directory>/admission.json
node dist/cli.js grade <run-directory> --config <judges.json> --retry-errors
node dist/cli.js report <run-directory> --grading-version <hash>
node dist/cli.js compare <baseline-directory> --against <candidate-directory>
```

Invoke the process with an argument array; avoid constructing a shell command from dataset contents. `--help` and command-specific `--help` also return JSON. Paths supplied on the CLI resolve relative to the process working directory. Paths inside configuration resolve relative to the configuration file, including a separate JSON/JSONL dataset's provider paths.

CLI `run` and `grade` default to formal admission. For development, set `--mode exploratory` explicitly on both operations. An existing execution run or grading version cannot switch modes. The low-level library defaults remain exploratory; use `runFormalEvaluation` and `gradeFormalEvaluation` for gated library calls. See [admission.md](admission.md) for the full contract. `version` returns installed direct dependency versions and a local implementation fingerprint.

On success or a retained partial result, stdout contains exactly one JSON value. An exception produces an `{ "error": { "name": "...", "message": "..." } }` object on stderr and a nonzero exit code. Other diagnostics can also appear on stderr. Do not assume all stderr lines are JSON.

Exit code zero means the requested operation completed without a reported missing/failed execution or grading slot. Nonzero status also represents blocked or incomplete results; parse stdout when present before deciding the next action. Reporting an ungraded run produces its execution coverage and an incomplete report. A score of zero can still accompany successful command execution.

Valid `abstained` and `insufficient_evidence` records complete a judging call, so `grade` can exit zero with those outcomes. `report` still marks the score aggregate incomplete. Inspect both coverage and record statuses.

## Resume and recovery

`resume` reuses the saved execution plan and checks tracked source-file hashes. It skips completed trials. `--retry-errors` requests another attempt for eligible failed trials. With `retrySafe: false`, retrying any failed target attempt is rejected, including cleanup and simulation failures. This flag must reflect the target's actual reset/idempotency contract. Repeating a case intentionally and retrying an uncertain external operation have different meanings.

Formal resume and repeated grading automatically revalidate their stored receipts. Receipts expire after 24 hours. Renew against the same configuration with a new probe/calibration, then pass `--preflight <new-receipt>` to `resume` or `--calibration <new-receipt>` to `grade`. Preserve prior evidence directories. Changed declared environment values require a new run/version; a fresh receipt cannot silently mix services within existing formal evidence. Reports stay readable after receipt expiration because they describe completed work.

`resume` automatically inherits exploratory or historical execution status. To re-enter an exploratory or historical grading version through the CLI, use `grade <run> --config <judges> --mode exploratory`, optionally with `--retry-errors`. Without that flag the CLI requests formal admission and rejects the mode change. `legacy_unverified` is a report label inferred from older manifests, not an accepted `--mode` value.

When isolation, cleanup, or an uncertain interruption leaves the run blocked, inspect `state.json`, the `attempts/` ledger, and the trial artifact first. A started attempt whose artifact is missing has an unknown outcome and blocks the run. `recover` requires no unsettled operation owned by the original process, successful recovery verification, and successful adapter closure before clearing the block. It does not rerun a target operation. A recovered run can still report pending or failed slots and therefore a nonzero exit status.

Do not clear a blocked state by editing files. Do not remove unsuccessful attempts to make a report complete. For a managed service, recovery must actually restore or verify the relevant external state.

Run directories use a `proper-lockfile` lease: a five-second heartbeat and a 30-second stale threshold. Concurrent operations fail while the lease is held. After a crash, allow stale-lease handling; never manually remove a live lock. Acquiring an expired lease does not establish that the target's external operations have stopped.

If a referenced source file changes, create a new execution plan/run. Changed grading sources create a distinct grading version on the same saved outputs. A reusable library process refuses to reload changed tracked sources; restart the process to avoid stale module dependencies. Each CLI invocation already starts a fresh process. When several grading versions exist, select the intended version explicitly.

## Working with results

- An execution artifact identifies the run, case, repeat, attempt, and session; it retains messages, output, metadata/evidence, isolation results, and any errors. Repeats are zero-based; attempts are one-based.
- A grading record ties the result to a specific execution attempt and output hash, judge, grading repeat, and grading version.
- `manifest.json` and the grading manifest define what should have run; `attempts/` records which target attempts started. Do not count only the artifact files that happen to be present.
- `report` returns `executionCoverage`, `gradeCoverage`, per-case/per-execution/per-judge detail, execution/grading block states, `complete`, and `overall`. `overall` is `null` when coverage is incomplete or a state is blocked.
- `admission.execution` and `admission.grading` distinguish formal, exploratory and historical evidence; `runtime` describes the captured local implementation. Formal grading does not promote exploratory execution to formal status.
- Observed statistics describe available values only. They are not a replacement aggregate with missing judges or cases silently reweighted.

## Agent responsibilities

one-eval executes the supplied contracts. It does not establish universal isolation for a black-box endpoint, validate arbitrary business truth from a fluent answer, or prove that a simulated user obeyed all scenario facts. Configure evidence collection and grading accordingly. Supplying an API key enables a connection; it does not grant a plain LLM API code-writing or tool-execution capabilities.

In-process adapters are trusted code and must honor `AbortSignal` without blocking the Node.js event loop. Timeouts cannot forcibly terminate that code or prove a remote operation stopped. List all local source/script imports and other behavior-relevant files in `files`; source snapshots preserve configuration and tracked file contents, not the provider's actual deployed model/service version.

Use [usage.md](usage.md) and [the shared types](../src/types.ts) as the preparation contract. Credentials should come from environment references, while committed examples and retained configuration snapshots contain placeholders.
