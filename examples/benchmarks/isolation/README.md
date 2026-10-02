# Context isolation and local refund workflow challenges

These synthetic integration cases complement GSM8K and IFEval. They are local
acceptance challenges, not an external benchmark or an estimate of general model quality.

Run `node examples/benchmarks/isolation/prepare.mjs --out data/isolation-20261002`
to create two datasets, two command-grader configurations, and a provenance file.
Existing different files are never overwritten. The generator makes no target calls.

Use `../agent-workflow/target.mjs` as the module target. For isolation set
`config.enableTools` to `false` and `config.instructions` to the exported
`ISOLATION_INSTRUCTIONS` in `cases.mjs`. For the refund workflow keep tools enabled
and use its default instructions. Include the target's imported source files,
these generator source files, and the generated provenance in the execution
configuration's `files` list. References remain on the grading side; pass only
`messages` to the target. The target records `conversationStrategy: transcript-replay`:
each turn uses a fresh Codex invocation containing the current trial's transcript.
This tests replayed dialogue history, without claiming a native resumed session.

## Context challenge

Eight cases contain 19 target turns per repeat: three interleaved memory/probe
pairs, one overwrite case, and one clear case. Use execution concurrency **1** and
preserve dataset order. With two repeats this is 16 trials and 38 model calls.
one-eval runs both repeats of a case before moving to the next case. The three
blank probes therefore follow a seeded trial even with case-major repetition.

The same vault-token question appears in recall and blank probes. A recall case
must return its previously supplied token after a distractor. A blank case has no
token in its own input and must return exactly `UNKNOWN`. Probe prompts do not
tell the model to ignore prior cases. Overwrite must return the replacement;
clear must return `UNKNOWN`. All assistant replies are checked after trimming
outer whitespace. A foreign fixture token in a reply is an explicit failure.
No session or thread ID is used in scoring. Missing transcripts produce
`insufficient_evidence`; wrong answers produce zero.

These outcomes challenge visible conversation contamination at this adapter
boundary. A pass does not establish that every hidden remote memory mechanism is
absent. Deliberately contaminated transcripts and forgotten own-case tokens are
negative controls in the local grader tests, not additional real model trials.

## Local workflow challenge

Eight cases contain 11 target turns per repeat: order-ID clarification, an
already-refunded order, unpaid and shipped denials, paid refund with a follow-up
status read, an explicit query-only request, eligible delivered refund, and an
expired return window. Two repeats mean 16 trials and 22 model calls.

The agent calls an actual local MCP server over stdio. Each trial owns a fresh
synthetic order database; within-trial turns retain it. Grading checks the complete
final database against an independent fixed oracle, actual tool audit records,
authorized order IDs, required refund receipts, and no mutation before order-ID
clarification. An answer claiming a refund without corresponding tool and state
evidence fails. Any unrelated order mutation also fails. A duplicate request must
preserve the existing refund count and ID; it may be handled with a read or an
idempotent refund call. Thus this case does not imply the model necessarily called
the refund tool twice.

Each refund request explicitly requires copying the supplied refund reason exactly.
For a newly issued refund the full-state oracle checks that exact string, including
capitalization. An already-refunded order keeps its original reason unchanged.

The grader requires only limited response text, such as receipt IDs and an order-ID
clarification. It does not establish overall helpfulness, factual accuracy outside
the fixture, or completeness of every natural-language explanation. The database,
MCP audit, and transcripts are preserved in target-call evidence before cleanup.
No external order service, real payment, or customer data is involved.
