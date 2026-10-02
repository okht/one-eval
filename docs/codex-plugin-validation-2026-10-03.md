# Codex plugin validation — 2026-10-03

The repository now provides a Codex plugin containing the `evaluate` skill and a dependency-free bridge to the existing one-eval CLI. The plugin manager installs the source package; an explicit setup builds its locked runtime in a separate cache. Evaluation inputs and artifacts remain in the caller's workspace.

## Local acceptance

Verified on Windows with Node.js 24.13.0:

- Codex CLI 0.144.6 discovered, installed and enabled the clean source plugin in an isolated profile. The desktop-bundled CLI 0.159.0-alpha.12.1 separately passed installation discovery.
- A clean setup installed dependencies and compiled the engine. Repeated setup reused the completed runtime.
- The installed bridge completed a formal offline workflow: two cases repeated twice, four execution records, four calibration checks and four grades, with a complete report.
- A missing execution receipt was rejected. Disabling the target module after execution did not prevent independent calibration, grading or reporting. Resume and repeat grading retained existing completed records.
- Paths containing spaces and the caller's working directory were preserved. Required skill, source, templates and lockfile were present; private data, run outputs and prebuilt dependencies were absent from the clean installation.
- `npm run typecheck` and `npm run build` passed. The strict regression suite passed **222/222 tests**, with no failures or skips. It includes ten new plugin runtime tests and the existing 900-trial/3,600-grade stress regression.
- Skill frontmatter validation and a separate integration review passed. The installation check asserts the expected plugin ID, installed path and enabled state.
- The CLI tarball also passed a clean consumer installation: executable entrypoint, ESM exports, TypeScript declarations, templates, six formal execution records and 36 saved-answer grades.

No target model or LLM judge calls were made for these checks. Offline fixture scores establish pipeline behavior, not model quality or remote-service isolation.

## Dependency and CI repair

The first public CI run stopped during dependency installation because npm 10.9.9 and 11.19.0 required peer/optional lock entries absent from the previous lockfile. The repaired lock adds 15 entries without changing existing package versions or direct dependencies. Clean installations with both npm versions passed, followed by typechecking, compilation and 11 provider/integration regression tests.

CI now runs the clean plugin installation workflow with Codex CLI 0.144.6, alongside the ordinary suite and CLI tarball check, on Windows and Ubuntu with Node.js 22 and 24. Consult GitHub Actions for the result of a particular commit; local acceptance alone does not establish that matrix result.

## Evidence and limits

Local evidence is retained under `results/plugin-20261003`, `results/plugin-ci-20261003`, and timestamped `results/plugin-installation-*` directories. Those ignored directories contain detailed commands, runtime identity and temporary installation/workspace locations. They are not bundled or published as plugin content.

Installation tests use separate Codex profiles and do not change the user's active plugin configuration. The runtime integrity check covers copied inputs, compiled output and direct dependency metadata; it does not attest every dependency file or create an operating-system sandbox. No official Plugins Directory submission or npm registry publication was performed.

See [installation and usage](codex-plugin.md).
