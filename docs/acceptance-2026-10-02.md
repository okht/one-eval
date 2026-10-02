# Initial implementation acceptance

Verified locally on 2026-10-02 using Windows, PowerShell 7.6.5, Node.js 24.13.0, and Promptfoo 0.123.1. one-eval is an independent agent-facing CLI/library project. No GUI was implemented.

## Checks

- `npm run build`: passed.
- `npm run typecheck`: passed.
- `npm test`: 56 tests passed, 0 failed.
- `git diff --check`: passed (Git reports the existing CRLF-to-LF normalization policy).

The tests include actual local HTTP requests, stateful session initialization/verification/cleanup, fixed and simulated multi-turn conversations, repeated requests without cache reuse, no hidden retry on HTTP 429, fresh judging contexts, script timeouts, missing evidence, weighted aggregation, source-version checks, partial traces, failed cleanup, started-attempt ledgers, recovery, and serialized persistence. CLI tests verify machine-readable stdout and nonzero status for incomplete operations.

Independent review identified recovery and persistence defects before acceptance. Fixes now prevent retrying unsafe failed operations, preserve completed records after partial writes, block recovery while an original operation remains active, retain started-attempt evidence when an artifact is lost, and require recovery cleanup to succeed before clearing the blocked state. `proper-lockfile` supplies the run-directory lease.

## Saved offline run

The example at `runs/acceptance-20261002/` contains:

- Run ID: `9acc33e5-89dc-481c-bf50-006209564ea8`.
- Two cases, three execution repetitions each: six completed artifacts.
- Two deterministic command judges, three repetitions each: 36 scored records.
- Complete coverage and an aggregate of 1.0 for these deliberately passing fixtures.
- A saved `report.json`, original artifacts, scoring records and source snapshots.

The fixture score demonstrates the execution and scoring workflow. It is not a quality measurement of a production model. The generated run directory is Git-ignored.

## Verification limits

No paid model service or production business system was invoked. Real LLM judgment quality, vendor-side model stability and application-specific remote isolation remain integration responsibilities. Dynamic simulation validates the control protocol; semantic adherence requires explicit grading or review. Supplied modules and commands are trusted executable code; the process controls are not an OS sandbox. An operation may continue remotely after a local timeout, so recovery requires application cooperation.

Agent entry point: [agent-guide.md](agent-guide.md). Input and adapter details: [usage.md](usage.md).
