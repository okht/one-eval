# Third-party notices

The one-eval GitHub repository is public. Its npm package retains `private: true` and `license: UNLICENSED`; public repository visibility does not grant an open-source license to one-eval. The npm tarball contains one-eval code, templates, selected examples and documentation; dependencies are installed separately by npm with their own license files.

The following direct dependencies are actually used. Versions and notices were checked against the installed packages and the lockfile on 2026-10-02. This inventory does not claim to be a legal audit of every transitive dependency.

## Runtime dependencies

| Package | Pinned version | Upstream license evidence | Use |
| --- | --- | --- | --- |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 0.123.1 | MIT; Copyright (c) Promptfoo 2025; installed `promptfoo/LICENSE` | Provider integrations and simulated-user calls |
| [MCP TypeScript SDK server](https://github.com/modelcontextprotocol/typescript-sdk) | 2.0.0-alpha.4 | Package metadata says MIT; installed `@modelcontextprotocol/server/LICENSE` contains the licensing transition described below | Repository benchmark workflow fixture; currently retained as a pinned direct dependency |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 4.1.2 | MIT; Copyright (c) 2018 Made With MOXY Lda &lt;hello@moxy.studio&gt;; installed `proper-lockfile/LICENSE` | Filesystem locks |
| [Zod](https://github.com/colinhacks/zod) | 4.1.12 | MIT; Copyright (c) 2025 Colin McDonnell; installed `zod/LICENSE` | Configuration and protocol validation |

The MCP package's actual license file documents a transition from MIT to Apache-2.0: new code/specification contributions and contributions with relicensing consent use Apache-2.0; original MIT contributions without consent retain MIT. Documentation excluding specifications uses CC-BY-4.0. The file includes the Apache-2.0 and MIT texts and a CC-BY-4.0 link. Its MIT notice is Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC. Preserve and consult the installed license file; the metadata alone does not describe this transition.

## Development and verification tools

| Package | Pinned version | License / notice |
| --- | --- | --- |
| [TypeScript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0; see installed `typescript/LICENSE.txt` and `ThirdPartyNoticeText.txt` |
| [tsx](https://github.com/privatenumber/tsx) | 4.20.6 | MIT; Copyright (c) Hiroki Osame &lt;hiroki.osame@gmail.com&gt; |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/node) | 24.10.1 | MIT; Copyright (c) Microsoft Corporation |
| [@types/proper-lockfile](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/proper-lockfile) | 4.1.4 | MIT; Copyright (c) Microsoft Corporation |

Development packages are not runtime dependencies of the tarball. npm, Node.js, Python and GitHub Actions retain their own upstream licenses. No third-party service credentials or historical evaluation outputs are included in the tarball.

## Repository-only benchmark assets

Benchmark source downloads, datasets and saved results are excluded from the distribution. The repository's pinned benchmark preparation scripts retain source URLs, revisions, checksums and downloaded license files alongside their assets. For example, the CI BFCL preparation uses the [Gorilla/BFCL source at revision f7cf7359b7ac615a0b294831c5ba2bc95ee4a000](https://github.com/ShishirPatil/gorilla/tree/f7cf7359b7ac615a0b294831c5ba2bc95ee4a000) and preserves its upstream `LICENSE`. Consult each asset's original license before redistributing those assets.
