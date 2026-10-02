# Private distribution and CI

one-eval has a public GitHub repository and a private npm package at version 0.1.0. `private: true` prevents npm registry publication, and `UNLICENSED` records that no open-source license has been granted for this project. Local tarball installation is supported. Building or installing a tarball does not publish it to the npm registry. Pushing repository changes triggers the configured GitHub Actions workflow.

## Package contents

The `package.json` `files` allowlist includes compiled JavaScript and TypeScript declarations under `dist`, starter templates, the offline and OpenAI-compatible examples, selected stable usage documents and third-party notices. npm also includes the root README and package metadata. Source maps, development sources/tests/scripts, local dependencies, benchmark downloads, historical acceptance runners, saved runs/results and dated report documents are excluded. Historical evidence links in the README refer to the repository checkout.

`one-eval` resolves to `dist/cli.js`. ESM consumers import the root package; TypeScript resolves `dist/index.d.ts`. A `prepack` lifecycle script rebuilds `dist` with the pinned TypeScript compiler. The package installs dependencies through npm rather than bundling their source. See [third-party notices](../THIRD_PARTY_NOTICES.md), including the MCP dependency's license transition.

```sh
npm ci --ignore-scripts
npm pack
# In another, empty directory:
npm install --ignore-scripts /absolute/path/to/one-eval-0.1.0.tgz
npx --offline one-eval schema
npx --offline one-eval init evaluation --template offline
```

The installed offline starter needs no API key or model connection. Follow its generated commands to create separate execution preflight and grading calibration receipts, execute trials, grade saved answers and generate a report. With a local npm installation, prefix the generated `one-eval` commands with `npx --offline` so npm resolves the installed binary. Normal CLI execution and grading use formal admission by default. Explicit exploratory mode is available for experiments; it is not a replacement for formal preflight.

## Installation smoke test

```sh
npm run test:package
```

The smoke test uses native `npm pack`, installs the tarball into a newly created empty temporary consumer directory, and calls the installed binary through npm's generated command shim. It verifies package contents, ESM exports, TypeScript declaration resolution, installed template assets, JSON schema and runtime version/implementation hashes. It then runs the packaged offline example through formal execution preflight, six execution trials, independent grading calibration, 36 saved-answer grades and a report. During calibration, grading and reporting, an environment guard makes importing the example target fail; this verifies those phases do not reload the target.

It preserves the tarball, command outputs, machine summary and copies of the probe/run/calibration artifacts under a new `results/distribution-<timestamp>/` directory. Retained receipts record the temporary canonical paths and serve as audit copies; a new evaluation directory needs its own valid admission evidence. Successful runs remove their owned temporary consumer directory after path/symlink checks. Failures retain the consumer path for investigation. Dependency installation can use the npm registry/cache; the evaluation itself makes no model calls. No API key is required.

## Regression layers

| Command | Coverage and prerequisites |
| --- | --- |
| `npm run test:unit` | Core regression suite without Python/BFCL asset requirements; includes local subprocess and filesystem checks |
| `npm run test:integration` | CLI, HTTP, provider protocol and benchmark adapter checks; requires Python >=3.10 and pinned BFCL assets |
| `npm run prepare:ci` | Acquires fixed BFCL sources and 40 deterministic cases when absent; verifies hashes without modifying existing assets |
| `npm run test:ci` | Every `tests/*.test.ts` file, with a mandatory zero-skipped-tests summary |
| `npm run test:package` | Fresh tarball installation and formal offline workflow |

The BFCL asset helper passes an explicitly non-executable download-only baseline to the existing preparation script. It records the Node binary only as a provenance hash and cannot pass the Codex target's version check. The helper never invokes a target/model. An incomplete or changed existing fixture directory fails verification rather than being overwritten. Python benchmark dependencies are pinned in `examples/benchmarks/requirements.lock.txt`; CI installs them with Python 3.11. Integration checks fail clearly if required Python/assets are missing, and strict CI rejects any skipped test.

## GitHub Actions configuration

The workflow configures Windows and Ubuntu with Node 22 and 24 (four combinations), Python 3.11, locked npm/Python dependencies, pinned BFCL preparation, type checking, build, the full zero-skip regression suite and tarball installation smoke. Official checkout/setup actions are pinned by commit. Permissions are limited to reading repository contents; the workflow has no publishing step, deployment or model credentials.

Adding a matrix records intended verification coverage. It does not establish that its remote jobs have passed. Local results must identify the actual OS and Node version; other combinations remain unverified until the workflow runs. Historical real-model acceptance is separate from this offline CI suite.

## Upstream mechanisms

- [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) defines `private`, `files`, `bin`, `exports` and `license`.
- [npm lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/) define the `prepack` build hook.
- [actions/setup-node](https://github.com/actions/setup-node) and [actions/setup-python](https://github.com/actions/setup-python) provide the standard CI runtimes and caches.
