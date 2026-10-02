# Execution probes and grader calibration

Execution and grading have separate checks. A target can be probed and evaluated before any judge is configured. Graders can be calibrated against saved answers without invoking a target.

Successful checks create an `admission.json` receipt and return its path as `receiptPath`. CLI `run` requires `--preflight <receipt>` and CLI `grade` requires `--calibration <receipt>` by default. Failed checks cannot authorize formal evaluation. Development can opt into `--mode exploratory`. See [admission.md](admission.md) for receipt expiration, configuration/runtime/environment binding and renewal. A receipt records bounded evidence; the isolation assumptions below still apply.

## Probe a target

```text
one-eval probe evaluation.json --out runs/probe-001 --cases 2
```

The probe selects the first cases in dataset order, uses one repeat and concurrency 1, and preserves the original timeout and any configured budgets. It defaults to two cases, accepts 1–10 cases, and rejects a selected set exceeding 30 possible target turns. A simulated conversation can also make simulator calls. Probe cases perform real target operations, including tools and business side effects configured by the adapter.

The output directory must not exist. The original prepared plan and configuration stay unchanged. The result records both the original plan hash and the derived probe plan hash. The probe uses the same prepare, verify, execute, cleanup, timeout, artifact and recovery machinery as a normal run. It does not automatically retry errors. Failed isolation verification blocks further execution; ordinary execution failures remain visible. Existing `recover` and `resume` commands can inspect/recover the retained probe run, but the original `preflight.json` is a snapshot of the initial probe and must not be treated as refreshed evidence after a retry. Use a fresh probe to obtain a new readiness result.

`preflight.json` contains `ok`, the selected case IDs, individual checks, the run summary, and isolation scope. A CLI failure exit status accompanies `ok: false`.

Isolation evidence is deliberately limited:

- A generic provider contributes a configured statelessness declaration.
- A module contributes its per-trial `verify` result.
- Unique runner session IDs demonstrate separate runner records. They do not establish isolation inside a remote service, a long-term memory store or an external database.
- This sequential sample does not certify concurrency or every dataset case. Add explicit cross-session sentinel cases and server-side state checks for stronger evidence.

Every normal trial still performs isolation verification before target execution. A successful probe does not bypass this lifecycle or guarantee future server state.

## Calibrate graders

Create known-answer fixtures, including a positive answer, a negative answer, and useful edge cases such as empty answers, missing evidence or conflicting instructions. Labeling and expected grades should come from the evaluation policy or a reviewed reference. Calibration verifies agreement with those fixtures; it does not establish that the policy itself is correct.

```json
{
  "version": 1,
  "fixtures": [
    {
      "id": "a",
      "label": "positive",
      "input": "What is 2 + 2?",
      "reference": "4",
      "output": "4",
      "expected": { "status": "scored", "minScore": 1, "maxScore": 1 }
    },
    {
      "id": "b",
      "label": "negative",
      "input": "What is 2 + 2?",
      "reference": "4",
      "output": "5",
      "expected": { "status": "scored", "minScore": 0, "maxScore": 0 }
    },
    {
      "id": "c",
      "label": "edge",
      "input": "What is 2 + 2?",
      "reference": "4",
      "output": "",
      "expected": { "status": "insufficient_evidence" }
    }
  ]
}
```

```text
one-eval calibrate fixtures.json --config judges.json --out runs/calibration-001
```

Fixture rules:

- The file contains 2–100 fixtures with unique IDs and at least one positive and one negative scored anchor.
- All positive minimum scores must exceed all negative maximum scores. Bounds are inclusive and between 0 and 1. This prevents a check with overlapping expectations from passing a grader that assigns the same score to everything.
- Edge fixtures can expect a score interval, `abstained`, or `insufficient_evidence`. An error is never a valid expected score or an implied zero.
- `reference` is optional JSON. `metadata` is optional saved execution metadata, such as tool evidence. Optional `messages` preserve a saved conversation; their first user message must match `input`, and their last message must be the assistant's `output`.
- Without `messages`, the imported transcript contains the input and saved output. Empty output is retained as an empty string.
- `label` and `expected` are stored in calibration evidence and withheld from grader inputs. Avoid labels or answer-status hints in fixture IDs or metadata. Graders receive the case reference and saved execution evidence they need to evaluate the answer.
- The complete calibration must schedule 2–10,000 judge calls. Existing grading budgets and timeouts still apply.

Every configured judge evaluates every fixture for every configured repeat. Each individual grade must satisfy its expected status and score interval; averaging cannot conceal a disagreeing repeat or judge. Missing slots, authentication failures, command crashes, malformed responses and timeouts fail calibration with their original statuses and reasons preserved.

The run directory explicitly records imported provenance and a target that cannot execute. `targetInvoked: false` is retained in the request and every imported artifact. Its execution state is blocked to prevent treating it as a resumable target run. This does not block independent grading. A normal evaluation report for that directory remains incomplete as an execution report; use `calibration.json` to interpret calibration results.

`calibration.json` contains `ok`, the frozen grading version, the fixture-file SHA-256, coverage counts, and each judge/repeat comparison. Original grade records remain under `grades/<version>/records`. The CLI returns a failure exit status if any comparison fails. Repeating calibration requires a new output directory. Existing grading commands can regrade imported answers with a revised judge, but they do not rewrite the initial calibration comparison report.

## Library API

```ts
probeExecution(preparedPlan, outputDirectory, { caseLimit: 2 });
calibrateGrading(preparedGrading, fixturesPath, outputDirectory);
getCalibrationFixturesSchema();
```

Both functions return machine-readable results and retain evidence. Input validation and directory ownership errors throw before target or judge calls. Runtime trial and grading failures appear as failed checks. Source files, plans and grading versions retain the existing content-hash protections.
