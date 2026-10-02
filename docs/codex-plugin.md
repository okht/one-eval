# Codex plugin

The one-eval plugin bundles the `evaluate` skill and a local runtime bridge to the existing CLI. Codex prepares inputs and interprets results; the same one-eval engine performs isolation lifecycles, preflight admission, repeated execution, independent grading and reporting. It adds no GUI or separate grading service.

## Install from the repository marketplace

Requires Git, Node.js 22.22 or newer, npm and a Codex client supporting local/repository plugins. The compatibility manifest supports the locally verified Codex CLI 0.144.6 format. Public directory listing is a separate submission process; this repository does not claim directory approval.

```sh
codex plugin marketplace add okht/one-eval --ref main
codex plugin add one-eval@one-eval-plugins
codex plugin list --marketplace one-eval-plugins --json
```

In the desktop app, refresh/restart if needed and select the one-eval marketplace in Plugins. A new chat can invoke the skill as `$one-eval:evaluate` or ask to use one-eval. The plugin provides a skill and executable CLI bridge; no MCP server connection or ChatGPT developer-mode configuration is required.

Example request:

> Use one-eval to evaluate my API against cases.jsonl. Run each case three times, keep trials isolated, then grade the saved answers with judges.json and report failures and coverage.

The plugin asks only for task information that is missing. API credentials remain process environment variables; installing the plugin does not configure a target or select a model automatically.

## Runtime setup

The installed plugin is a source package. The skill resolves its actual install location, then invokes:

```text
node <installed-plugin-root>/scripts/codex-plugin.mjs doctor
node <installed-plugin-root>/scripts/codex-plugin.mjs setup
node <installed-plugin-root>/scripts/codex-plugin.mjs schema
```

Setup downloads the locked npm dependencies with lifecycle scripts disabled and builds the engine in a separate writable cache. It makes no target or model calls. Ordinary commands never install dependencies automatically. The cache identity includes the bundled sources, dependency lock, templates and local Node/platform identity. Completed runtime inputs and compiled files are checked before reuse; this check does not hash all installed dependency code or create an OS sandbox.

`ONE_EVAL_PLUGIN_CACHE_DIR` optionally selects the cache parent directory. Use a persistent location: prepared formal receipts bind the runtime, so changing or rebuilding the implementation may require fresh preflight evidence. Keep datasets, custom adapters, credentials and output artifacts in the working project, outside the runtime cache and installed plugin directory.

Commands after setup accept the [same arguments and JSON protocol as the CLI](agent-guide.md), retaining the caller's working directory and exit status. The [formal admission requirements](admission.md) remain enabled. The [managed starter](integrations.md) must implement actual state reset and verification before formal evaluation can run.

## Develop or pin a version

Use a clean checkout as a local marketplace while developing:

```sh
git clone https://github.com/okht/one-eval.git
codex plugin marketplace add ./one-eval
codex plugin add one-eval@one-eval-plugins
```

The plugin is the repository root, selected by `.agents/plugins/marketplace.json`. Do not install a local directory containing private run artifacts or dependencies; use the Git-backed marketplace or a clean checkout. The test harness creates an allowlisted clean plugin copy.

For repeatable installation, use an audited commit with `--ref <commit>`. Update the marketplace through `codex plugin marketplace upgrade one-eval-plugins`, then refresh the installed plugin with the client. An update may require another runtime setup; prior evaluation artifacts are retained in their project.

The npm package remains private and UNLICENSED. Adding a repository marketplace does not publish a registry package or submit this plugin to the public Plugins Directory.

The existing npm tarball packages the CLI. The Codex plugin uses the Git-backed repository marketplace, which includes the source, lockfile, skill and bootstrap script needed for its first setup.

## Validation

Run `npm run test:ci` for the ordinary regression suite and `npm run test:plugin` for the separate clean plugin installation check. The latter verifies marketplace discovery, skill installation, isolated runtime setup and an offline formal evaluation workflow without making a model call. It uses a temporary Codex profile and retains its temporary evidence paths in a new `results/plugin-installation-<timestamp>/summary.json`. It does not enable or modify plugins in the caller's global profile. Set `ONE_EVAL_TEST_CODEX_BIN` to a Codex executable or the npm distribution's `codex.js` entrypoint when automatic detection is insufficient. Local client verification is separate from remote service acceptance and from public-directory review.

Official format and installation reference: [Package your plugin](https://developers.openai.com/plugins/build/plugins).
