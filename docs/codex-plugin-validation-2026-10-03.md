# Codex plugin validation — 2026-10-03

The repository now provides a Codex plugin containing the `evaluate` skill and a dependency-free bridge to the existing one-eval CLI. The plugin manager installs the source package; an explicit setup builds its locked runtime in a separate cache. Evaluation inputs and artifacts remain in the caller's workspace.

## Local acceptance

Verified on Windows with Node.js 24.13.0:

- Codex CLI 0.144.6 discovered, installed and enabled the clean source plugin in an isolated profile. The desktop-bundled CLI 0.159.0-alpha.12.1 separately passed installation discovery.
- A clean setup installed dependencies and compiled the engine. Repeated setup reused the completed runtime.
- The installed bridge completed a formal offline workflow: two cases repeated twice, four execution records, four calibration checks and four grades, with a complete report.
- A missing execution receipt was rejected. Disabling the target module after execution did not prevent independent calibration, grading or reporting. Resume and repeat grading retained existing completed records.
- Paths containing spaces and the caller's working directory were preserved. Required skill, source, templates and lockfile were present; private data, run outputs and prebuilt dependencies were absent from the clean installation.
- `npm run typecheck` and `npm run build` passed. The strict regression suite passed **224/224 tests**, with no failures or skips. It includes twelve plugin runtime tests and the existing 900-trial/3,600-grade stress regression. Two tests verify that installation and compiler progress arrive on stderr before completion while stdout remains one final JSON response.
- Skill frontmatter validation and a separate integration review passed. The installation check asserts the expected plugin ID, installed path and enabled state.
- The CLI tarball also passed a clean consumer installation: executable entrypoint, ESM exports, TypeScript declarations, templates, six formal execution records and 36 saved-answer grades.

No target model or LLM judge calls were made for these checks. Offline fixture scores establish pipeline behavior, not model quality or remote-service isolation.

## Dependency and CI repair

The first public CI run stopped during dependency installation because npm 10.9.9 and 11.19.0 required peer/optional lock entries absent from the previous lockfile. The repaired lock adds 15 entries without changing existing package versions or direct dependencies. Clean installations with both npm versions passed, followed by typechecking, compilation and 11 provider/integration regression tests.

CI now runs the clean plugin installation workflow alongside the ordinary suite and CLI tarball check, on Windows and Ubuntu with Node.js 22 and 24. The installation summary records the exact Codex client used. CI installs a global 0.144.6 fallback; on Ubuntu, npm's PATH resolves the lockfile's local 0.153.4 client. Consult GitHub Actions for the result of a particular commit; local acceptance alone does not establish that matrix result.

The [final matrix for `ba92fec`](https://github.com/okht/one-eval/actions/runs/37051210074) passed all four environments, including typechecking, compilation, the strict regression suite, clean plugin installation and the CLI tarball workflow. The installed plugin exercised four formal executions and four independent grades; the tarball workflow exercised six formal executions and 36 grades in each environment.

The first plugin matrix also exposed platform-specific test assumptions: Windows runners can supply an 8.3 temporary-directory alias, while adapters use its canonical path; Linux can retain a terminated process as a zombie PID. Tests now compare canonical directory identities and check bounded process termination with state diagnostics. A live process remains a failure. These changes retain the production isolation and termination behavior.

A later Windows regression exposed a timing-dependent timeout test: its 40 ms lifecycle deadline could expire during preparation, before the intended execution phase. The two related tests now wait for an explicit execution-entry barrier and advance a controlled clock. Their adapter deliberately returns a successful answer after cancellation, verifying that it cannot overwrite the saved timeout artifact, start the next case, or permit recovery while the operation remains active. Production timeout behavior is unchanged.

A subsequent Windows runner check exposed unusually slow dependency extraction into its default system temporary directory. All 832 package downloads were cache hits; installation was still making progress when its 600-second bound expired. A controlled run changed only the test's temporary-directory base to GitHub's `RUNNER_TEMP`, retaining the same runtime key, npm cache, dependency versions and timeout. Setup then completed in 51.3 seconds, including 48.0 seconds for npm, and the formal evaluation workflow passed. CI installation checks use the runner scratch directory. User runtime-cache defaults remain unchanged; the evidence does not isolate the underlying disk or system-scanning cause.

## Evidence and limits

Local evidence is retained under `results/plugin-20261003`, `results/plugin-ci-20261003`, and timestamped `results/plugin-installation-*` directories. Those ignored directories contain detailed commands, runtime identity and temporary installation/workspace locations. They are not bundled or published as plugin content.

Installation tests use separate Codex profiles and do not change the user's active plugin configuration. The runtime integrity check covers copied inputs, compiled output and direct dependency metadata; it does not attest every dependency file or create an operating-system sandbox. No official Plugins Directory submission or npm registry publication was performed.

See [installation and usage](codex-plugin.md).
