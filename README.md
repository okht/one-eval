# one-eval

An agent-facing CLI and TypeScript library for isolated, repeatable evaluation of models, agents, workflows, and chatbots. An external agent prepares the dataset and adapters, invokes the tool, and analyzes saved results. Commands return one JSON object on stdout; diagnostics use stderr and incomplete or failed operations return a nonzero exit status. There is no GUI.

**Status: internal beta for technical users and external agents.** Promptfoo 0.123.1 provides provider integrations and batch scheduling. one-eval adds explicit isolation lifecycles, saved execution artifacts, independently versioned judging, and coverage-aware aggregation. CLI execution and grading require separate successful preflights by default.

## Offline quickstart

Requires Node.js 22.22 or newer and npm. From this repository:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js schema
node dist/cli.js init ./my-evaluation --template offline
node dist/cli.js probe my-evaluation/eval.json --out runs/readiness
node dist/cli.js run my-evaluation/eval.json --out runs/offline --preflight runs/readiness/admission.json
node dist/cli.js calibrate my-evaluation/calibration.json --config my-evaluation/judges.json --out runs/calibration
node dist/cli.js grade runs/offline --config my-evaluation/judges.json --calibration runs/calibration/admission.json
node dist/cli.js report runs/offline
```

The generated starter uses an independent in-memory session per trial, two cases with two repeats, a multi-turn transcript, and an exact-reference command grader. It makes no network model calls and requires no SQLite native build. Its four calibration fixtures cover correct, incorrect, empty and missing-reference answers. Use fresh output directories for another run. These checks validate the tool and supplied rule; they do not establish real-model judgment quality.

The CLI also generates `openai-compatible`, `http` and `managed` starters. See [integration starters](docs/integrations.md) for endpoint contracts and environment configuration. The managed scaffold fails until its lifecycle is implemented. To test without preflight admission, explicitly use exploratory mode:

```sh
node dist/cli.js run examples/offline/eval.json --out runs/exploratory --mode exploratory
node dist/cli.js grade runs/exploratory --config examples/offline/judges-llm-mock.json --mode exploratory
node dist/cli.js report runs/exploratory
```

The mock LLM returns a fixed score to test the protocol. Reports expose execution and grading admission modes separately. Historical evidence is labeled `legacy_unverified`; exploratory work cannot be relabeled as formal. Receipts expire after 24 hours and bind the prepared sources, local runtime, declared environment settings and saved evidence. See [formal admission](docs/admission.md). When multiple grading versions exist, select one explicitly for the report.

For a clean package install, use the local tarball workflow in [distribution](docs/distribution.md). The GitHub repository is public. The npm package retains `private: true` to prevent registry publication, and its license remains `UNLICENSED`; repository visibility does not grant an open-source license.

## Integration surface

- [Agent guide](docs/agent-guide.md): call sequence, machine-readable results, recovery, and external agent responsibilities.
- [Configuration and adapter contracts](docs/usage.md): datasets, local modules, remote providers, multi-turn execution, scoring commands, and report semantics.
- [Execution probes and grader calibration](docs/preflight.md): separate target checks and known-answer fixtures, with individual judge-repeat acceptance.
- [Formal admission](docs/admission.md): receipt verification, expiration, runtime/environment binding, exploratory mode and migration.
- [Integration starters](docs/integrations.md): existing Promptfoo adapters for compatible models and HTTP targets, plus offline and managed modules.
- [Distribution and CI](docs/distribution.md): a private tarball, clean-install checks and the configured platform matrix.
- [Admission and distribution validation](docs/delivery-2026-10-02.md): 212 passing tests, 300 cases with three repeats, historical report compatibility and a clean tarball installation.
- [Diagnostics, limits, and report analysis](docs/reliability.md): retained failure causes, attempt caps, start spacing, observed grading cost, category reports, judge disagreement, and run comparison.
- [Reliability acceptance report](docs/hardening-2026-10-02.md): real repeated judging with two models, semantic and exact-rule calibration, and native stateful HTTP sessions.
- [Expanded reliability regression](docs/regression-v2-2026-10-02.md): adversarial persistence and recovery, concurrent repeated evaluations, expanded real judging, and historical evidence checks.
- [OpenAI-compatible templates](examples/openai-compatible): separate target and judge endpoint/model configuration. Fill in the placeholders before use; templates are not executed by the offline example.
- [Open-source benchmark example](examples/benchmarks/README.md): pinned GSM8K and IFEval datasets, isolated Codex CLI calls, official scoring rules, and reproducible sampling. See the [2026-10-02 smoke report](docs/benchmark-smoke-2026-10-02.md) for real-model results.
- [Expanded evaluation](docs/benchmark-expanded-2026-10-02.md): 256 cases across GSM8K, IFEval, BFCL-adapted function generation, context challenges, and actual MCP workflows; two repeats, saved failures, and [reproduction steps](examples/benchmarks/expanded-README.md).
- [Shared TypeScript types](src/types.ts): programmatic input and artifact contracts.

```ts
import { preparePlan, probeExecution, runFormalEvaluation,
  prepareGrading, calibrateGrading, gradeFormalEvaluation, buildReport } from 'one-eval';

const execution = await preparePlan('./eval.json');
const probe = await probeExecution(execution, './runs/probe');
if (!probe.receiptPath) throw new Error('Inspect the failed execution probe.');
const run = await runFormalEvaluation(execution, './runs/example', probe.receiptPath);
if (run.blocked || run.failed || run.pending) throw new Error('Inspect execution artifacts first.');
const grading = await prepareGrading('./judges.json');
const calibration = await calibrateGrading(grading, './calibration.json', './runs/calibration');
if (!calibration.receiptPath) throw new Error('Inspect the failed grader calibration.');
await gradeFormalEvaluation(run.directory, grading, calibration.receiptPath);
const report = await buildReport(run.directory, grading.versionHash);
```

The lower-level `runEvaluation` and `gradeEvaluation` APIs default to exploratory for compatibility. Use the formal wrappers above or pass explicit admission options for gated library calls. Historical acceptance reports, benchmark preparation scripts and `src/` links in this README are repository-only; the tarball includes compiled JavaScript, types, starters and stable usage documentation. Raw datasets, run artifacts, logs and local installation packages under `data/`, `runs/` and `results/` are excluded from Git. Dated reports describe the local validation snapshot; links into those excluded directories require the original local evidence or a new reproduced run.

Execution and grading are separate operations. Grading reads saved artifacts without loading the target adapter. An empty saved output remains a saved result and never triggers a fallback call to the target.

Run data lives beneath the output directory: `manifest.json`, `state.json`, `attempts/`, `artifacts/`, and `grades/<gradingVersion>/`. Keep these files together. The started-attempt ledger detects missing artifacts and blocks execution when an operation's outcome is unknown. The run manifest fixes the planned denominator.

## Limits of the current implementation

- The core imports JSON and JSONL. An external agent converts Excel, CSV, or other source material into the documented case format and preserves provenance in case metadata.
- Remote stateless isolation relies on an explicit, accurate endpoint contract. Fresh messages cannot prove that an arbitrary service has no server-side memory. Stateful systems require a module adapter with initialization, verification, and cleanup.
- Modules and scoring commands are trusted code; this release has no OS security sandbox. In-process adapters must honor `AbortSignal` and avoid blocking the event loop. A timeout cannot forcibly terminate an in-process adapter or prove that a remote operation stopped.
- Dynamic-user responses are checked against the message/stop protocol. Semantic adherence to scenario facts requires a grading rule or external review.
- `retrySafe: false` prevents retrying any failed target attempt. Recovery requires verified state, successful adapter closure, and no unsettled operation owned by the original process before the run is unblocked.
- Tracked source changes require a fresh process; library callers must restart after edits. List all behavior-relevant local source/script imports in `files`. Snapshots cover configuration and tracked files, not the actual version of an external service or model.
- Reports retain missing, failed, abstained, and insufficient-evidence slots. The aggregate remains `null` while scores are unavailable or a run/grading state is blocked. A valid low score is a result, not a command failure.
- There is no built-in agent for writing adapters or inventing business scoring policies. The external agent performs that work, and supplied prompts and scripts determine evaluation policy.

## Development

```sh
npm run typecheck
npm test
npm run build
```

Tests use local fixtures, loopback HTTP services and mocks; they do not establish isolation for a real remote service or validate the quality of a real LLM judge. `npm run test:ci` rejects skipped tests; `npm run prepare:ci` installs/verifies benchmark fixtures for a fresh checkout, and `npm run test:package` exercises a clean tarball installation. These checks do not call a paid model.

Run the separate readiness checks without credentials:

```sh
node dist/cli.js probe examples/offline/eval.json --out runs/offline-probe --cases 2
node dist/cli.js validate examples/offline/judges.json --grading
node dist/cli.js calibrate examples/offline/calibration.json --config examples/offline/judges.json --out runs/offline-calibration
```

These commands require new output directories. The calibration contains correct,
incorrect, empty, and missing-rule answers; every configured judge repeat is checked.
