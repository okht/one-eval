# Integration starters

`one-eval init` creates a small, editable evaluation project. It uses the existing Promptfoo providers for standard APIs and the existing lifecycle adapter contract for stateful agents and workflows. It does not create an API service or call a model during initialization.

```text
one-eval init ./my-evaluation --template offline
one-eval init ./my-model --template openai-compatible --endpoint http://127.0.0.1:8000/v1 --model your-model
one-eval init ./my-service --template http --endpoint http://127.0.0.1:8000/invoke
one-eval init ./my-agent --template managed
```

The destination must be absent or an ordinary empty directory. Existing files are never overwritten. Concurrent initializers use an exclusive lock and exclusive file creation. If initialization fails after creating some files, its error identifies those files; partial work is retained for inspection. Choose a new directory after inspecting a partial result.

| Template | Reused integration | Ready to run | Isolation evidence |
| --- | --- | --- | --- |
| `offline` | Local lifecycle module and command grader | Yes, without network access | Fresh local fixture state is checked and released for each trial |
| `openai-compatible` | Promptfoo `openai:chat` provider | After setting endpoint, credential and model variables | Fresh per-case messages; remote statelessness is a service-owner declaration |
| `http` | Promptfoo HTTP provider | After setting variables and matching the request/response contract | Fresh per-case messages; remote hidden state is unverified |
| `managed` | Lifecycle module scaffold | After implementing and testing its TODOs | Requires authoritative checks of remote conversation, memory and business state |

Every starter contains a two-case dataset, a deterministic exact-reference grader, and four calibration fixtures covering correct, incorrect, empty and missing-reference answers. The dataset includes a scripted follow-up, Unicode, quotation marks and newlines. Execution repeats both cases twice. These examples test integration behavior; their scores do not establish a model's general quality. Replace the cases, reference answers and grading criteria for the actual task.

## Environment and paths

Generated provider configurations retain environment references such as `${ENV:ONE_EVAL_API_KEY}`. `.env.example` contains inert examples and placeholders. One-eval does not load it automatically or copy credential values from the initializing process. `--endpoint` and `--model` populate this example file; they do not embed resolved values into `eval.json`.

Set these variables in the process that runs one-eval:

- `ONE_EVAL_ENDPOINT`: OpenAI-compatible API base URL or the complete HTTP invocation URL.
- `ONE_EVAL_API_KEY`: credential used in the Authorization header; an unused placeholder works for a local service that ignores authentication.
- `ONE_EVAL_MODEL`: model name for the OpenAI-compatible template.

For example, these PowerShell assignments target a local OpenAI-compatible service:

```powershell
$env:ONE_EVAL_ENDPOINT = 'http://127.0.0.1:8000/v1'
$env:ONE_EVAL_API_KEY = 'unused-local-placeholder'
$env:ONE_EVAL_MODEL = 'your-model'
```

Use the service's approved secret injection mechanism for real credentials. Do not put credentials in command-line flags, endpoint query parameters, source files or committed JSON. Remove the HTTP template's Authorization header if the service has no authentication. Relative case, adapter and grader paths resolve from their configuration file.

The JavaScript API also supports custom variable names:

```typescript
await generateStarter({
  directory: './my-service',
  template: 'http',
  endpointEnv: 'TEAM_EVAL_ENDPOINT',
  apiKeyEnv: 'TEAM_EVAL_API_KEY',
});
```

The returned value lists created files, required variable names and the next commands. Names must be distinct valid environment identifiers. The managed adapter's configuration also retains explicit `${ENV:NAME}` references; its small local resolver reads those declared bindings from `process.env`. Formal admission fingerprints these explicit settings. Add every behavior-affecting environment binding explicitly to the configuration rather than relying on additional implicit environment reads in the adapter.

## Formal workflow

Run these commands from the generated directory, with `one-eval` available on PATH:

```text
one-eval probe eval.json --out runs/probe
one-eval run eval.json --out runs/eval --preflight runs/probe/admission.json
one-eval calibrate calibration.json --config judges.json --out runs/calibration
one-eval grade runs/eval --config judges.json --calibration runs/calibration/admission.json
one-eval report runs/eval
```

Probe and calibration execute real target/grader calls. A successful probe issues the execution admission receipt; a successful calibration issues the grading receipt. Changes to covered configuration, sources or environment require a fresh matching receipt. Use fresh output directories for a new evaluation. The explicit `--mode exploratory` route supports development without formal admission. A small probe demonstrates its tested behavior; it does not certify every case or unknown service state.

The exact-reference grader compares the final saved answer to the dataset's string reference, including whitespace and punctuation. Missing reference yields `insufficient_evidence`. Update the calibration fixtures when changing the grader. The example's perfect offline result validates the pipeline and matching rule only.

## OpenAI-compatible protocol

This starter is verified against the installed **Promptfoo 0.123.1** `openai:chat` implementation. It sets `apiBaseUrl`, `apiKey` and `model` through environment references. Promptfoo appends `/chat/completions` to the base URL and sends the same-case message array. The configured model is used without a starter-selected fallback. The starter disables provider retries and unnecessary default generation parameters. Configuration options are documented by [Promptfoo's OpenAI provider reference](https://www.promptfoo.dev/docs/providers/openai/).

Use this template for a model or agent that already exposes the compatible chat-completions contract. Tool calls, long-running workflow jobs, shared memory and server-side session control require the service's actual contract; choosing the compatible transport alone does not manage those resources.

## HTTP protocol

The HTTP starter reuses **Promptfoo 0.123.1** with `method: POST`, an empty object body and an object-returning `transformRequest`. The request is:

```json
{
  "input": "the current user message",
  "messages": [
    { "role": "user", "content": "the current user message" }
  ],
  "sessionId": "the runner's trial session ID"
}
```

Later scripted turns include the preceding user and assistant messages from that case. `input` always contains the current user message. The default response expression requires `{ "output": "text" }`; non-2xx responses fail. Edit `transformRequest`, headers and `transformResponse` to match the existing service. These mechanisms come from [Promptfoo's HTTP provider](https://www.promptfoo.dev/docs/providers/http/).

The object transform is deliberate: this installed version recursively coerces JSON-looking strings when rendering nested body templates, and warns with request headers for some string-body templates. The generated transform preserves literal message text, including JSON-looking strings, without triggering that warning. Local loopback tests verify both transports with Unicode, quotes, backslashes, newlines, multi-turn transcripts and repeated cases. They also verify that the template's normal provider logs do not expose the supplied credential and that HTTP 503 fails without hidden retries.

`sessionId` is a runner identifier, not proof that the remote API has initialized or reset a session. A stateless declaration cannot verify a shared account's hidden memory, database mutations, workspaces or external actions.

## Managed agents and workflows

The managed scaffold intentionally fails before invoking a target. Its `prepare` throws a TODO error, `verify` returns `ok: false`, and interrupted-state recovery also returns false. It cannot pass the generated preflight until its lifecycle is implemented.

Implement the adapter around the already deployed service:

1. `prepare`: create or reset the real conversation and any case-owned memory, workspace, database fixtures or business-side-effect namespace. Record partially created resources so failed preparation can be reconciled.
2. `verify`: query authoritative service state and prove that the new trial cannot see prior-case messages, persistent memory or business mutations. A fresh UUID alone is insufficient evidence.
3. `execute`: invoke the service with the current case transcript and bound remote identifiers; forward cancellation, disable hidden retries, and retain relevant tool/state evidence.
4. `cleanup`: release or reset owned resources and verify the result, including after a timeout. Cleanup may need a separate bounded request after the execution signal has been aborted.
5. `recover`: reconcile interrupted resources and possible external effects before explicit retry can proceed. Retry safety depends on the real operation's behavior.

The generated target file is included in source tracking automatically. Add every imported local helper and other behavior-affecting file to `eval.json`'s `files` array, using paths relative to the config. Source tracking covers declared files; the scaffold cannot discover arbitrary dynamic imports or remote deployments. Match the declared `independent` scope only after per-case resources are actually independent; shared-state integrations require the corresponding scope and reset discipline.

Conversation isolation and business-state isolation are separate checks. A new chat session may still access the same persistent memory, user account, database or external system. Keep the adapter blocked until its evidence covers the state relevant to the evaluation.
