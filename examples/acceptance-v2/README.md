# Expanded real acceptance, revision 2

This revision keeps every earlier input, adapter and result unchanged. It broadens real-model acceptance by failure mode: grading contradictions and policy boundaries, concurrency with per-trial canaries, and real simulated users driving native stateful conversations.

The [2026-10-02 live report](report-2026-10-02.md) records 146/146 completed CLI invocations, 96/96 matched grader outcomes, 15/15 concurrent native trials and 4/4 real simulated-user trials. No invocation or low score was retried.

## Preregistered plan

The preparation step saves `cases.json` separately from `gold.json`, including independent expected statuses, score bands and rationales. The combined calibration file is only input to the calibration harness; the harness withholds labels and expected scores from judge prompts. The fixtures are agent-authored and inspectable; no claim of human annotation is made.

- 24 saved-answer fixtures × two requested models × two repetitions: 96 real judge calls. Coverage includes semantic paraphrase, partial credit, contradictory claims, irrelevant verbosity, strict JSON, escaped quotes/newlines, Unicode normalization, candidate prompt injection, absent evidence, explicit grader abstention, appropriate and inappropriate refusals, and empty answers. Existing known behaviors and fresh adversarial cases are both represented.
- Five native stateful scenarios × three repetitions, concurrency three: 15 trials and 30 expected target turns. Recall, overwrite, clearing, blank sessions and a cross-conversation bait prompt use a unique `CANARY_` token derived from every trial/repeat/attempt/session identity. The canary is never disclosed to blank probes.
- Two real simulated-user scenarios × two repetitions: four trials, ten expected target turns and ten expected simulator calls. The simulated user is a real LLM and receives only its own scenario and transcript. It chooses recall/update messages and ends the conversation through the message/stop protocol. The bounded maximum is 32 combined target/simulator calls.

Expected total: 146 invocations; worst case before retries: 158; hard limit: 180. All live phases run sequentially and share one persistent evidence directory. This avoids a budget race between separate runner processes. Within each phase, reservations are serialized by the reused pinned Codex helper.

The reused Codex helper and native HTTP service are explicitly tracked configuration dependencies. Their source is not modified by this revision. Existing authenticated native `codex-cli 0.144.6` is used without copying credentials, enabling tools or taking real business actions. Requests select `gpt-5.6-sol` and `gpt-5.6-luna`, previously verified by real calls; preparation rechecks local supported-model metadata and CLI version without adding readiness calls.

## Reproduce

Use fresh data, run and result paths. Each phase must exit before the next starts, including when a phase returns a nonzero status for retained mismatches. Inspect errors before deciding whether to continue.

```sh
node examples/acceptance-v2/prepare.mjs data/acceptance-v2-new results/acceptance-v2-new <absolute-native-codex-executable>
node --import tsx examples/acceptance-v2/run-phase.mjs grading data/acceptance-v2-new runs/acceptance-v2-new-grading results/acceptance-v2-new/grading.json
node --import tsx examples/acceptance-v2/run-phase.mjs native data/acceptance-v2-new runs/acceptance-v2-new-native results/acceptance-v2-new/native.json
node --import tsx examples/acceptance-v2/run-phase.mjs simulated data/acceptance-v2-new runs/acceptance-v2-new-simulated results/acceptance-v2-new/simulated.json
node examples/acceptance-v2/summarize.mjs data/acceptance-v2-new results/acceptance-v2-new runs/acceptance-v2-new-grading runs/acceptance-v2-new-native runs/acceptance-v2-new-simulated
```

After inspecting first-attempt execution errors and confirming disposable session cleanup, an operator may invoke `retry-native` or `retry-simulated` once through the same phase runner, writing `<phase>-retry.json`. The runner rejects a second retry. It never retries completed answers, low scores, judge disagreements or invalid simulated conversations. Every invocation remains subject to the shared 180-call cap.

## Evidence boundaries

Native resumed turns send only the latest HTTP user message and reuse the same Codex thread within one trial. Summary checks compare the adapter's transport evidence to raw CLI input, verify thread/canary uniqueness, inspect foreign-canary leakage, and confirm session and working-directory cleanup. Codex's persisted native history remains available for audit. A high-level timeout still cannot prove an arbitrary remote request stopped.

These results concern local real-model-backed HTTP and two models in one provider family. They do not establish production API isolation, cross-vendor judge independence or general expert-level scoring quality. All mismatches stay visible against the original gold expectations.
