# Controlled agent workflow target

This module target connects the already authenticated Codex CLI 0.144.6 to one
local stdio MCP server. It is a self-authored functional check of real tool use,
multi-turn conversations, state changes, and trial isolation. Its scores are
separate from open-source benchmark scores.

`createTarget` accepts `binaryPath` (an absolute native executable), optional
`model`, optional `enableTools` (default `true`), and optional static
`instructions`. For plain conversation isolation checks, set `enableTools:false`
and supply appropriate instructions. Authentication uses the existing CLI login;
this example does not read or copy credentials.

Each trial owns a new directory under the system temporary directory, a fresh
order database, and an empty audit. Each turn starts a new ephemeral CLI thread
and replays only that trial's actual user/assistant transcript. The database
persists between turns. This is transcript replay, not native session resume.
The target accepts only the exact preceding transcript plus one user message.
No reference answer or case identifier is inserted into the prompt.

The `orders` MCP server exposes only `list_orders`, `get_order`, `refund_order`,
and `get_refund_status`. Tool arguments contain business identifiers, with no
arbitrary path or command access. A serialized handler records every accepted
call's arguments and result and atomically replaces the JSON database. Refunds
are idempotent; unpaid, shipped, and ineligible orders are refused. Shell,
browser, plugins, memory, and other configured tool providers are disabled.

Every successful turn returns `metadata.threadId`, full CLI `events`, cumulative
`toolAudit`, and a `finalState` snapshot. The target matches completed MCP events
one-to-one against current-turn audit entries by tool, arguments, and result.
The core stores this under `artifact.metadata.target.calls[n].metadata`. Token
usage is reported separately by each target call. `eachTurnNewThread:true` and
`trialDatabasePersists:true` make the execution strategy explicit.

Abort or excessive output terminates the native process tree and waits for exit
before cleanup. Cleanup removes only the owned temporary directory. A failed
turn cannot continue in that trial. The read-only CLI sandbox and restricted
tools do not prove remote hidden state isolation or constitute a general file
read sandbox. Source snapshots should include `target.mjs`, `server.mjs`,
`fixture.mjs`, the grading/case sources, and the dependency lockfile. They do not
freeze the hosted model implementation.

Offline verification:

```sh
node --import tsx --test tests/agent-workflow.test.ts
```

An explicitly requested live two-turn probe can be run with:

```sh
node examples/benchmarks/agent-workflow/probe.mjs --binary /absolute/path/to/codex --model YOUR_MODEL
```

On Windows, use the absolute `codex.exe` path, not the npm PowerShell/CMD shim.
The native executable must report exactly `codex-cli 0.144.6`. The installed MCP
SDK is `@modelcontextprotocol/server@2.0.0-alpha.4`, pinned by the root project.
