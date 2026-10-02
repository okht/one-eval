# Real judge and native stateful acceptance

This bounded acceptance run exercises two remaining integration boundaries using the existing authenticated Codex CLI. It does not require a new API key or copy credentials. It invokes no business tools and does not modify a production service.

The [2026-10-02 acceptance report](report-2026-10-02.md) records 88 total CLI calls: 60 real judge calls, two readiness probes and 26 native stateful calls including two preserved capacity failures. All final calibration and dialogue checks passed after one explicit retry for each failed stateful trial.

## What is measured

- Twelve frozen, pre-labeled saved answers, scored twice each by `gpt-5.6-sol` and `gpt-5.6-luna`: 48 judge calls. Cases cover correct and wrong answers, empty output, Unicode, candidate prompt injection, absent rules, exact-format distinctions, and two imported GSM8K answers. No original benchmark target is called again. The fixture labels and expected score bands are withheld from the judges.
- Six scripted memory scenarios, twice each: 12 trials and 22 model turns. A loopback HTTP service owns a separate Codex thread for every trial. The HTTP request contains only the newest user message. Later turns use `codex exec resume <thread-id>`; no conversation transcript is replayed by one-eval. Recall, overwrite, clearing, and three cross-case blank probes are included.
- Every native call creates a start record and terminal result with exact CLI events, requested model, usage, thread ID, timings and diagnostics. No retry is automatic. The planned run uses 72 calls including the two model-readiness probes.
- A separate semantic-rubric calibration adds three agent-authored fixtures (complete paraphrase, clear contradiction, and one-of-two requirements met), each scored twice by both models: 12 additional calls. The expected scores 1, 0, and 0.5 are fixed before model invocation. These are inspectable illustrative fixtures, without a claim of human annotation.
- Service cleanup removes the session capability and its owned working directory. A deleted HTTP session returns 404. Codex's persisted native history is retained for audit; cleanup does not claim to erase Codex global history.

The tests use a pinned native `codex-cli 0.144.6`. User/project configuration and rules, memory, tools, app integrations, plugins and web search are disabled. Judge calls are ephemeral and stateless. Native stateful calls are deliberately persisted to support true resume.

## Reproduce

Use fresh output directories. The preparation script imports two specific completed answers from `runs/expanded-20261002-gsm8k`, and records their hashes and original run/trial identities. It fails if those source artifacts are unavailable. The CLI executable must be an absolute native path, not a shell shim.

```sh
node examples/acceptance/probe.mjs <native-codex-executable> results/acceptance-new
node examples/acceptance/prepare.mjs data/acceptance-new <native-codex-executable> results/acceptance-new
node --import tsx examples/acceptance/run-calibration.mjs data/acceptance-new runs/acceptance-new-calibration results/acceptance-new/calibration.json
node --import tsx examples/acceptance/run-native.mjs data/acceptance-new runs/acceptance-new-native results/acceptance-new/native.json
node examples/acceptance/prepare-semantic.mjs data/acceptance-new data/acceptance-new-semantic results/acceptance-new
node --import tsx examples/acceptance/run-calibration.mjs data/acceptance-new-semantic runs/acceptance-new-semantic results/acceptance-new/semantic-calibration.json
node examples/acceptance/summarize.mjs results/acceptance-new runs/acceptance-new-native
```

Calibration and execution have independent preconditions: generating answers does not require a grading rule. The calibration runner imports saved answers through `calibrateGrading`; it never initializes a target. The native runner executes first and grades saved output separately.

The dedicated budget guard limits invocation starts in one runner process and accounts for existing start records. Run the steps sequentially when relying on that guard across processes. The frozen plans independently bound normal call counts; neither runner automatically retries a failed model invocation or a mismatched score.

If the native target has first-attempt infrastructure failures and its disposable session has been cleaned, an operator can explicitly invoke `retry-native.mjs <data> <run> <results>/native-retry.json`. It permits one retry of first-attempt execution errors, preserves original failures and completed answers, and never retries a valid low score. Re-run the summary command afterwards.

## Interpretation

These small known-answer fixtures verify real provider transport, fresh grading contexts, repeated scoring and strict policy adherence. They cannot establish general semantic judging quality or cross-vendor independence. Both judges belong to one provider family. The requested model identifier is recorded and accepted by the CLI; ephemeral event streams do not expose a second independent server model identifier.

The stateful service is a local real-model-backed HTTP integration. Results apply to its explicit session lifecycle, with no certification of arbitrary production API memory, databases or caches.

The automated tests in `tests/acceptance.test.ts` check event parsing, tool rejection, call-budget refusal, native resume argument construction and the service lifecycle using an injected deterministic invoker. They do not consume real model calls.
