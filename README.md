# one-eval

A lightweight evaluation tool for isolated, repeatable runs and configurable multi-model judging of models, agents, workflows, and chatbots.

**Status: requirements alignment.** Implementation has not started. The capabilities below describe the intended design.

## Core idea

Target execution and judging share a common batch-running mechanism:

**Prepare inputs -> run independently -> save outputs -> repeat as configured.**

During target execution, the input is an evaluation case and the output is a response or task result. During judging, the input includes the original case, the saved result, an optional reference answer, and scoring instructions. The output contains a score or verdict with its rationale.

Each evaluation is a bounded task with a user-defined number of repetitions. Target execution and judging have separate repetition settings.

## Planned capabilities

- Evaluate models, agents, workflows, and chatbots through remote APIs or callable interfaces to existing local deployments.
- Configure how many times each case runs.
- Start every case attempt with an independent context, preventing conversation history from carrying across cases or repeated attempts.
- Save execution results and score them immediately or later.
- Configure judge API connections and scoring prompts separately.
- Use multiple judging models, with independently configurable scoring repetitions.
- Rescore saved results when scoring instructions change.
- Preserve individual outputs, scores, and rationales alongside aggregated results.
- Allow external agents to configure, run, and inspect evaluations, and to participate as judges.

The initial scope is a callable evaluation tool without a GUI. Interface details are still to be determined.

## Context isolation

Isolation applies to each case attempt and each judging attempt. Every attempt starts from its defined initial inputs and context.

Isolation requires cooperation from stateful targets. Targets that retain server-side sessions or persistent memory need suitable session separation, memory isolation, or reset support. Clearing outgoing messages alone cannot establish that guarantee. The tool should report whether the required isolation conditions are met.

## Example

For a dataset of 300 cases:

- Running each case 3 times produces 900 execution results.
- Scoring each result with 2 judges, 3 times per judge, produces 5,400 judgments.
- Saved execution results can be judged again without rerunning the target.

## Decisions to finalize

- How multi-turn cases preserve context within an attempt and reset it between attempts.
- How scores are aggregated across judges, judging repetitions, and execution attempts.
- Dataset formats, target adapters, and the external agent interface.
