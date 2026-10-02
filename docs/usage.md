# Configuration and extension contracts

CLI `run` and `grade` default to formal admission and require successful execution and grading preflights respectively. Use `--preflight <probe>/admission.json` and `--calibration <calibration>/admission.json`. The explicit `--mode exploratory` option permits development runs without these gates. See [admission.md](admission.md), [preflight.md](preflight.md) and [integration starters](integrations.md). Admission does not change the scoring or isolation contracts below.

## Execution configuration

Call `one-eval schema` for machine-readable execution and grading JSON Schemas. Use `examples/offline/eval.json` as a runnable starting point. Top-level fields are `version: 1`, `name`, `cases`, `target`, `execution`, and optional `files`. Schema describes the structure; `validate` also applies cross-field rules and source-file checks.

`cases` is a nonempty array or a path to a JSON array/JSONL file. Each case has:

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable case ID. |
| `input` | Initial user input, including an intentionally empty string if needed. |
| `reference` | Optional JSON reference answer or expected state. |
| `metadata` | Optional JSON object containing provenance or other case context. |
| `weight` | Positive aggregation weight; defaults to 1. |
| `conversation` | Optional fixed or dynamic multi-turn specification. |

Without `conversation`, the target is called once. A scripted conversation uses `{ "mode": "scripted", "turns": ["next user message"] }`; `input` is the first user turn and `turns` contains subsequent user turns. Actual assistant replies are kept in the current attempt's history.

A simulated conversation uses `mode: "simulated"`, `goal`, optional `facts` and `constraints`, a simulator `provider`, and `maxTurns`. The maximum counts target calls including the initial input. The simulator receives the scenario and current conversation, without the reference answer. It must return exactly one JSON decision:

```json
{ "action": "message", "content": "My order number is 12345." }
```

or:

```json
{ "action": "stop", "reason": "There are no remaining user requests." }
```

The simulator decides natural termination; the tool enforces the target-call limit and trial timeout. Ending the conversation does not imply passing the evaluation. Invalid protocol output is a simulation error; semantic scenario violations require a dedicated check.

`execution` contains `repeats` (default 1), `concurrency` (default 1), and `timeoutMs` (default 60000). These govern target trials. Judge repeats are configured separately. Shared environments require `concurrency: 1`.

Optional `maxAttempts` and `minIntervalMs` cap retained trial attempts and space trial starts. Grading accepts these fields at its top level, plus an optional observed-cost threshold `maxCost`. See [reliability.md](reliability.md) for exact counting, missing-cost behavior, and limits.

## Target contracts

`target.kind` is `provider` or `module`. Every target declares:

```json
{
  "isolation": {
    "mode": "managed",
    "scope": "independent",
    "evidence": "Describe the session and business-state isolation mechanism."
  },
  "retrySafe": false
}
```

`independent` means each trial has its own relevant state space. `shared` means trials use one state space with serialized reset/execution/cleanup. `retrySafe` means another attempt is safe following a failed or uncertain operation, under the adapter's actual reset/idempotency contract. Its default is false, which forbids retrying every failed target status, including cleanup and simulation failures.

### Stateless providers

Set `kind: "provider"`, `isolation.mode: "stateless"`, and `provider`. A provider is a Promptfoo provider ID or `{ "id": "...", "config": { ... } }`. A local custom provider can use `file://./provider.cjs`. Caching is disabled for these calls.

The target receives the current attempt's messages only. This establishes outgoing-message separation. The endpoint's declared lack of persistent memory remains a dependency of the isolation claim. Use a managed module when you need server session creation, database reset, or other lifecycle operations.

The [OpenAI-compatible templates](../examples/openai-compatible) work as connection templates for either local HTTP inference servers or remote compatible endpoints. Set endpoint/model values for the actual service. `${ENV:TARGET_API_KEY}` and `${ENV:JUDGE_API_KEY}` refer to environment variables and keep secrets out of committed configuration. Target and judge connections are independent.

### Managed local modules

A module at `target.path` exports `createTarget(config)` returning a `TargetAdapter`, or exports an adapter object as default. Paths resolve relative to the execution configuration. Methods can invoke local commands or HTTP APIs as needed; the core does not infer their business-state behavior.

```ts
interface TargetAdapter {
  prepare(context: TrialContext): Promise<Json>;
  verify(session: Json, context: TrialContext): Promise<{ ok: boolean; evidence: string }>;
  execute(messages: Message[], session: Json, context: TrialContext): Promise<TargetReply>;
  cleanup(session: Json, context: TrialContext): Promise<void>;
  recover?(context: { runId: string; workDir: string; signal: AbortSignal }): Promise<{ ok: boolean; evidence: string }>;
  close?(): Promise<void>;
}
```

The context includes `runId`, `trialId`, `caseId`, zero-based `repeat`, one-based `attempt`, fresh `sessionId`, `signal`, `workDir`, and configuration `baseDir`. `prepare` establishes the initial state. `verify` checks it before target execution. `execute` receives the full current transcript and returns `{ output: string, metadata?: object }`. Put tool results or final business-state evidence in `metadata`. `cleanup` must release or reset state; a failure must not be hidden.

Adapters run as trusted in-process code. Honor `AbortSignal` in all I/O, cancel owned child processes when applicable, and never block the Node.js event loop. Timeout detection is cooperative: the engine cannot forcibly terminate a module or prove that a remote operation stopped. Recovery remains blocked while the original process has an unsettled operation and requires both successful verification and successful adapter closure before clearing the run's blocked state.

A fresh session ID alone does not isolate account-level memory, shared files, orders, or databases. The adapter must cover the state relevant to the case and report the verified scope honestly. An independent session should not delete other sessions' state during cleanup. Target outputs must be strings, including valid empty strings; serialize structured results explicitly and put tool or state evidence in metadata. Available cost and numeric token-usage totals are retained under `metadata.target` and `metadata.simulator`, with their per-call records in `calls`.

See [the offline module](../examples/offline/target.mjs) for a complete implementation. It uses fresh in-memory state for each session. Replacing it with a real application requires real lifecycle evidence.

## Independent judging

A grading file contains `version: 1`, a nonempty `judges` array, `concurrency`, `timeoutMs`, and optional `files`. Each judge has a unique `id`, `kind`, positive `weight`, and positive `repeats`.

An LLM judge supplies `kind: "llm"`, `provider`, and `prompt`. Edit the prompt independently of the target connection. Each call receives fresh grading input containing the case, saved artifact, instructions, judge ID, and grading repeat. It must return the same schema as a command grader. The saved answer and trace are evaluation data; scoring prompts should clearly establish which instructions govern the judgment.

Use a stateless endpoint for the direct LLM judge path. A stateful external judging agent must create and verify an independent session for each invocation through its custom provider or command adapter. A fresh outgoing prompt alone cannot verify hidden server-side judge memory. The adapter must return an error when its isolation requirements cannot be established.

A command judge supplies `kind: "command"`, `command`, optional `args`, optional `prompt`, and optional `env`. The executable is invoked without shell interpolation. Use a command available on PATH or an explicit executable path. Existing file arguments resolve relative to the grading file and are content-hashed.

One JSON `GradeInput` arrives on stdin:

```ts
{
  case: EvalCase;
  artifact: TrialArtifact;
  instructions: string;
  judgeId: string;
  repeat: number;
}
```

Return exactly one JSON `GradeValue` on stdout:

```json
{ "status": "scored", "score": 0.8, "reason": "The answer satisfies most criteria." }
```

or:

```json
{ "status": "insufficient_evidence", "reason": "The final order state was not supplied." }
```

`abstained` is also supported with a reason. Scores must be finite numbers from 0 through 1. Put command diagnostics on stderr. Invalid JSON, invalid scores, nonzero exit, and timeout are recorded as grading errors. These are distinct from a valid score of zero. Valid abstentions and insufficient-evidence outcomes are terminal records: `grade` can exit zero while the subsequent report still lacks a complete aggregate.

Commands run in separate per-call working directories. Optional `cwd` selects the parent directory, not a shared grading working directory. Optional `env` maps a child variable name to a host environment-variable name, for example `{ "SERVICE_TOKEN": "MY_GRADING_SERVICE_TOKEN" }`.

Scoring scripts are trusted local programs and this release has no OS security sandbox. They should read their supplied material and return a grade; do not import or invoke the target as part of regrading. The engine itself never loads a target for grading.

## Versions and saved evidence

Execution and grading configurations have independent content versions. The tool hashes configuration, the case file, local provider/module files, existing file arguments, and explicit `files` entries. List all behavior-relevant local source/script imports and data files in `files`; transitive imports and package environments are not automatically frozen. Reusable library processes refuse changed tracked sources and require a fresh process. CLI invocations are already separate processes. Credentials referenced through environment variables are not committed as inline values.

Snapshots preserve configuration and tracked file contents. They do not capture the actual deployed version of a remote provider, model, or service; record that evidence separately when needed.

New manifests also retain the local one-eval implementation hash, version, Node version, platform, architecture and installed direct dependency versions. Formal receipts bind that runtime and declared environment references through hashes. Environment values are not stored in receipts. Untracked imports, transitive dependency versions and implicit SDK environment defaults are outside this binding; explicitly declare behavior-relevant settings. Existing historical manifests remain readable and are marked `legacy_unverified`.

Changing judge instructions or source files creates a new grading version without repeating target execution. Repeating the same grade command skips existing grade slots; use `--retry-errors` for failed scoring attempts. Historical records remain retained. Missing artifacts and hash mismatches must not silently improve coverage.

Artifact output hashes cover output, messages, and metadata. These detect accidental inconsistencies; the run directory is not an authenticated or tamper-proof audit log. Retain the whole directory, including manifests, state, and the `attempts/` started-attempt ledger. A ledger entry without its corresponding artifact blocks the run because the external outcome is unknown.

Concurrent access uses `proper-lockfile` with a five-second heartbeat and a 30-second stale lease. Never delete a live `.one-eval.lock` manually. Expired-lock recovery only restores file access; target state still requires the normal recovery checks.

## Aggregation

For each execution result, average each judge's scoring repeats, then apply judge weights. Average the execution-repeat scores for each case, then apply case weights across cases. This prevents a judge with more repeats from receiving an unintended larger weight.

The complete aggregate requires all configured scores and unblocked execution/grading states. Missing, failed, abstained, insufficient-evidence, and invalid execution slots remain visible; the final aggregate is `null` until complete. Available-value statistics are reported separately and are never substituted for the full aggregate.

The report retains raw grades and reasons. Repeated judgments describe grader variability; repeated target trials describe execution variability. They are different sample counts. User grading rules determine what scores mean, including any business pass/fail policy.
