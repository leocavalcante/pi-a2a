# Pi extension standard

Version 1 · 2026-11-10

This standard applies to pi-a2a, pi-otel, pi-subagents, pi-tmux, and every new Pi extension maintained by @leocavalcante. Each repository keeps an identical copy of this file at `docs/pi-extension-standard.md`. To change the standard, change every copy, using pull requests with the same title.

**MUST** means CI enforces the rule or review blocks the change. **SHOULD** is the default; record any deviation in the repository's CONTRIBUTING.md.

## Contents

1. [Principles](#1-principles)
2. [Identity](#2-identity)
3. [Toolchain](#3-toolchain)
4. [Package manifest](#4-package-manifest)
5. [Repository layout](#5-repository-layout)
6. [Tests](#6-tests)
7. [Continuous integration](#7-continuous-integration)
8. [Releases](#8-releases)
9. [Documentation](#9-documentation)
10. [Voice and tone](#10-voice-and-tone)
11. [GitHub settings](#11-github-settings)
12. [Security](#12-security)
13. [Runtime conventions](#13-runtime-conventions)
14. [Compatibility](#14-compatibility)
15. [Starting a new extension](#15-starting-a-new-extension)
16. [Appendix: reference files](#appendix-reference-files)

## 1. Principles

1. **Each repository stands alone.** There is no shared repository and no cross-repository workflow. Shared files are copies, and the copies stay identical (see [A.1](#a1-shared-files)).
2. **Bun builds, Node.js runs.** Bun is the development toolchain. Pi loads extensions on Node.js, so Node.js is the runtime target and the final test.
3. **Releases are automatic.** Merging a Conventional Commit to `main` is the only release action. `cd.yaml` chooses the version, tags it, publishes it, and writes the release notes.
4. **Every published version is attested.** CI builds every version and publishes it through npm Trusted Publishing, with provenance.
5. **One voice, many extensions.** Each extension has its own description, topics, and README, all written in the voice described in §10.

## 2. Identity

- **Names.** The repository is `leocavalcante/pi-<name>` and the npm package is `@leocavalcante/pi-<name>`. `<name>` is a short lowercase noun for the integration, such as `tmux` or `otel`. Before you name a new extension, search npm and [pi.dev/packages](https://pi.dev/packages) for namesakes.
- **Scoped names everywhere (MUST).** Install commands, badges, and docs use the scoped name. Every current extension name also exists unscoped on npm, published by someone else.
- **Description (MUST).** Each extension writes its own, following §10. It's one sentence of 100 characters or fewer that starts with a verb, names Pi, and ends with a period. Use the same text in `package.json`, the GitHub About box, and under the README title.
- **Topics (MUST).** Each extension picks its own 6–12 topics.
  - Include `pi-extension`, `pi-package`, and `pi-coding-agent`. Pi users search for these ecosystem topics, and about 1,900 repositories use each of them.
  - Choose the rest for the extension's domain. Skip language names and generic tags such as `ai` or `llm`.
  - The `keywords` field in `package.json` uses the same list. The `pi-package` keyword is what lists the package in the Pi gallery.
- **Homepage.** The GitHub website field is `https://pi.dev/packages/@leocavalcante/pi-<name>`. The `homepage` field in `package.json` points to the GitHub README.
- **Gallery media (SHOULD).** Set `pi.image`, and optionally `pi.video`, to raw GitHub URLs. Store the image as `.github/media/preview.png` at 1280×640, and upload the same image as the repository's social preview.
- **License.** MIT, with `Copyright (c) <year> Leo Cavalcante`. Derived work keeps the upstream notice and adds this line.

## 3. Toolchain

| Concern            | Standard                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language           | TypeScript 6.0.x, pinned exactly. typescript-eslint supports TypeScript `<6.1.0`; move to 7.x once it supports 7.                                                                                                                                    |
| Package manager    | Bun, pinned with `"packageManager": "bun@1.4.4"`, which setup-bun reads. Commit `bun.lock`, not `package-lock.json`. `bunfig.toml` sets `install.exact = true`.                                                                                      |
| Dependency scripts | Blocked, which is Bun's default. Keep `trustedDependencies` empty unless a dependency can't work without its install script.                                                                                                                         |
| Runtime target     | Node.js 22.19.0 or newer (`engines.node`, the same floor as Pi). Code in `src/` uses `node:*` APIs only: no `Bun` global and no `bun:*` imports. The root `tsconfig.json` loads only Node.js types, and ESLint rejects Bun imports in `src/`.        |
| Formatter          | Prettier with default options: 2 spaces, double quotes, semicolons, trailing commas, and 80 columns. `.prettierrc.json` contains `{}`. Prettier formats TypeScript, JSON, YAML, and Markdown.                                                        |
| Linter             | ESLint flat config with typescript-eslint `strictTypeChecked` and `stylisticTypeChecked`, followed by `eslint-config-prettier`. Type-aware rules such as `no-floating-promises` and `no-misused-promises` catch unawaited work in Pi event handlers. |
| Editor             | `.editorconfig` (2 spaces, LF, final newline) and `.gitattributes` (`* text=auto eol=lf`).                                                                                                                                                           |
| Publishing         | The npm CLI, driven by semantic-release. `bun publish` can't produce provenance, and it refuses to publish when `publishConfig.provenance` is set.                                                                                                   |

`tsconfig.json` ([A.2](#a2-tsconfigjson)) follows common TypeScript practice:

- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and the `noUnused*` checks are on.
- `verbatimModuleSyntax`, `isolatedModules`, and `moduleDetection: "force"` are set.
- `module` and `moduleResolution` are `nodenext`, because Node.js is the runtime.

`tests/tsconfig.json` extends it and adds Bun types. Packages that also export an SDK add a `tsconfig.build.json` that emits `dist/` with declarations.

## 4. Package manifest

**Field order:** name, version, description, keywords, homepage, bugs, repository, license, author, type, exports (SDK packages only), files, scripts, dependencies, peerDependencies, peerDependenciesMeta, devDependencies, engines, packageManager, publishConfig, pi.

**Required fields (MUST):**

- `"version": "0.0.0-development"`. The release workflow sets the real version ([§8](#8-releases)).
- `"type": "module"`, `"engines": { "node": ">=22.19.0", "pi": ">=<min>" }`, and `"publishConfig": { "access": "public", "provenance": true }`. `engines.pi` declares the minimum supported Pi, which the `pi-min` job reads; npm and Bun ignore it.
- `repository.url` set to `git+https://github.com/leocavalcante/pi-<name>.git`, plus `bugs.url` and `"license": "MIT"`.
- `files` as an allowlist:
  - `src/`
  - `dist/`, for SDK packages
  - `CHANGELOG.md`, which is generated at release time and which Pi reads from the installed package
  - any runtime assets
  - npm adds README and LICENSE by itself.

**Dependencies (MUST):**

- Never put Pi host packages in `dependencies`. They are `@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, and `typebox`.
  - When you import one, declare it in `peerDependencies` with `"*"`.
  - Mark it optional when the package also works outside Pi.
- Pi packages that Pi doesn't provide, such as `pi-telemetry`, go in `dependencies`.
- Optional peers that aren't Pi host packages use caret ranges.
- devDependencies use exact versions. The `@earendil-works/pi-coding-agent` devDependency is the Pi version the extension is tested with.

**Scripts (MUST use these names):**

| Script              | Runs                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`             | `tsc -p tsconfig.json && tsc -p tests`                                                                                                                        |
| `lint`              | `prettier --check . && eslint .`                                                                                                                              |
| `format`            | `prettier --write . && eslint --fix .`                                                                                                                        |
| `test`              | `bun run test:bun && bun run test:node`                                                                                                                       |
| `test:bun`          | `bun test --timeout 30000`. Bun's 5-second default is too short for integration tests, and `bunfig.toml` can't change it.                                     |
| `test:node`         | `node --import jiti/register --test "tests/**/*.node-test.ts"`                                                                                                |
| `verify`            | `lint`, `check`, `test`, `build` if present, `bun audit --audit-level=high`, `publint`, and `npm pack --dry-run`. These are the CI gates, run on one machine. |
| `build` + `prepack` | SDK packages only: `tsc -p tsconfig.build.json`                                                                                                               |

**Pi manifest:** `"pi": { "extensions": ["./src/extension.ts"] }`, plus `pi.image` (SHOULD).

There is no project `.npmrc`. Keep `.npmrc` in `.gitignore`, because that's where tokens leak.

## 5. Repository layout

```text
.github/
  CODEOWNERS                  * @leocavalcante
  dependabot.yml
  pull_request_template.md
  ISSUE_TEMPLATE/             bug_report.yml, feature_request.yml, config.yml
  media/preview.png           gallery and social preview (not published)
  workflows/                  ci.yaml, cd.yaml, pr-title.yaml
docs/pi-extension-standard.md this file
src/extension.ts              Pi entry: default-export factory, no work at import time
src/index.ts                  library entry, SDK packages only (compiled to dist/)
tests/*.test.ts               Bun lane
tests/*.node-test.ts          Node.js lane, including load.node-test.ts
tests/tsconfig.json
AGENTS.md  CONTRIBUTING.md  LICENSE  README.md  SECURITY.md
.editorconfig  .gitattributes  .gitignore  .git-blame-ignore-revs  .prettierrc.json
bunfig.toml  bun.lock  cliff.toml  eslint.config.mjs  package.json  .releaserc.json
tsconfig.json  [tsconfig.build.json]
```

`CHANGELOG.md` is generated at release time and listed in `.gitignore`. `examples/` and other `docs/` are optional and not published, except examples in SDK packages.

## 6. Tests

- **Bun lane (default).** Tests in `tests/**/*.test.ts` use `bun:test` and run with `bun run test:bun`.
- **Node.js lane.** Tests in `tests/**/*.node-test.ts` use `node:test` and run with `bun run test:node`, which loads TypeScript through jiti, the same loader Pi uses.
  - `tests/load.node-test.ts` (MUST) loads `src/extension.ts` under Node.js with a fake `ExtensionAPI` and checks the tools, commands, and events it registers. It catches Pi API drift and code that only works under Bun.
  - Tests about runtime behavior belong in this lane: child processes, signals, pipes, and file-system races. Bun emulates these Node.js APIs differently. For example, 13 of pi-subagents' process tests fail under Bun and pass under Node.js.
- **Package test.** The CI `package` job packs the tarball and checks its file list: the entry point, `CHANGELOG.md`, and no tests. It then installs the tarball into a temporary project and imports it under Node.js.
- Tests make no network or paid model calls. Use fakes, faux providers, and temporary directories. Tests that need an external tool such as tmux skip cleanly when it's missing.
- `bun test` on its own runs only the Bun lane; `bun run test` runs both lanes.

## 7. Continuous integration

Workflows use the `.yaml` extension. `ci.yaml` runs on pull requests, whenever `cd.yaml` calls it, on demand, and once a week.

| Job         | Runs on                              | What it does                                                                                                                     |
| ----------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `static`    | Ubuntu                               | `bun run lint`, `bun run check`, `bun audit --audit-level=high`, publint, actionlint, zizmor, and gitleaks over the full history |
| `test`      | Ubuntu, macOS, Windows               | `bun run test` (both lanes)                                                                                                      |
| `node`      | Ubuntu × Node.js 22.19.0, 22, 24, 26 | `bun run test:node`                                                                                                              |
| `pi-min`    | Ubuntu, Node.js 22.19.0              | Both lanes against the minimum supported Pi version from `engines.pi`                                                            |
| `package`   | Ubuntu                               | Packs, inspects, installs, and imports the package under Node.js                                                                 |
| `pi-canary` | Weekly and on demand                 | Both lanes against the latest Pi; opens or updates a `pi-compat` issue when they fail                                            |
| `required`  | Always                               | Fails if any job above failed or was cancelled. It's the only required CI check.                                                 |

- Repository-specific jobs go in the same file and in `required.needs`. Examples: tmux builds, Windows process supervision, older Pi pins.
- Tests that need an external tool, such as tmux, install it in `.github/scripts/setup-test-tools.sh`. The `test` and `pi-min` jobs run that script when it exists, so the shared jobs stay identical.
- An older Pi can resolve dependencies it no longer works with. List the exact versions it needs per Pi version in `.github/scripts/pi-pins.json`, such as `{ "1.0.4": { "@earendil-works/pi-codemode": "1.1.0" } }`. `install-pi.ts` adds them when it installs that version.
- `pr-title.yaml` checks that pull request titles are Conventional Commits, because each squash commit title becomes a release note. Titles are limited to 72 characters, except Dependabot's, which are longer but still conventional.
- **Hygiene (MUST):**
  - Pin actions to full commit SHAs, with a version comment.
  - Default workflows to `permissions: contents: read`.
  - Check out with `persist-credentials: false`.
  - Install with `bun install --frozen-lockfile`.
  - Pin runner images: `ubuntu-24.04`, `macos-15`, `windows-2025`.
  - Cancel superseded runs on pull requests only.

## 8. Releases

`cd.yaml` ([A.5](#a5-cdyaml)) runs on every push to `main`:

1. It runs `ci.yaml` on the merged commit.
2. semantic-release reads the Conventional Commits since the last `v*` tag. If none of them triggers a release, it stops.
3. git-cliff renders the release notes and a complete `CHANGELOG.md` from git history, using a single template (`cliff.toml`).
4. semantic-release then:
   - sets the version in the workspace and creates the `vX.Y.Z` tag
   - publishes to npm through Trusted Publishing, with provenance, from the `npm` environment
   - creates the GitHub release and comments on the released pull requests.

**Version rules while below 1.0:**

| Commit                                                      | Release                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `feat`                                                      | minor                                                    |
| `fix`, `perf`, `revert`                                     | patch                                                    |
| `docs(readme)`                                              | patch, so npm and the Pi gallery show the updated README |
| Breaking change (`!` or `BREAKING CHANGE:`)                 | minor below 1.0, major from 1.0 on                       |
| `build`, `chore`, `ci`, `docs`, `refactor`, `style`, `test` | none                                                     |

- **Dependabot.** Updates to runtime dependencies use `fix(deps)` and release a patch. `chore(deps)` and `ci(deps)` updates don't release.
- **Nothing is committed back.**
  - The version on `main` stays `0.0.0-development`. The real version lives in tags, npm, and GitHub releases.
  - `CHANGELOG.md` is generated into the npm package, where Pi reads it, and is listed in `.gitignore` in the repository.
  - As a result, no bot needs to bypass branch protection and no token is stored.
- **Changelog format (MUST).** Headings look like `## [X.Y.Z] - YYYY-MM-DD`, which Pi parses. Pi adds the package name to each heading and renders the notes in the terminal. Use absolute links only. Entries come from PR titles, so write them for users (§10, rule 11).
- **npm setup for each package:**
  - A trusted publisher for `cd.yaml` with the `npm` environment, allowing `npm publish`. A new trusted publisher expires unless it completes a publish within 2 days, so create it right before merging a releasable change.
  - `npm trust` commands, including `npm trust list`, need a 2FA approval in the browser. Don't pass `--json`: npm then holds back the approval link until the command ends.
  - Publishing access set to "require 2FA and disallow tokens", once the first trusted publish has succeeded. Trusted publishing keeps working, because it doesn't use tokens.
  - No `NPM_TOKEN` anywhere. Nobody publishes from a laptop.
- **Recovery.** Check npm first after a failed release. If the version is absent, an administrator may delete only the failed tag and re-run CD after fixing the cause. If npm already has the version, never delete its tag or republish it: verify provenance and restore a missing GitHub release from that tag. Package fixes need a new version.
- **Git installs** (`pi install git:github.com/leocavalcante/pi-<name>`) track `main` and report `0.0.0-development`, so Pi doesn't show update notes for them. npm is the release channel.

## 9. Documentation

| File                               | Content                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                        | The user guide, structured as in [§10.3](#103-readme-structure-must).                                                                                                     |
| `CONTRIBUTING.md`                  | Setup; running a checkout in Pi with `pi -e ./src/extension.ts`; `bun run verify`; the test lanes; commits and pull requests; how releases happen; changing workflows.    |
| `SECURITY.md`                      | Only the latest release gets fixes. Report privately through GitHub's form, saying what to include and what to redact. Rotate exposed credentials before you report them. |
| `AGENTS.md`                        | Rules for coding agents ([A.9](#a9-agentsmd)).                                                                                                                            |
| `.github/ISSUE_TEMPLATE/`          | A bug report form (Pi version, extension version, install source, Node.js version, OS, and steps, with a privacy reminder) and a feature request form.                    |
| `.github/pull_request_template.md` | What changed and why, how it was verified, the release note its title produces, and docs updated.                                                                         |
| `.github/CODEOWNERS`               | `* @leocavalcante`                                                                                                                                                        |
| `docs/pi-extension-standard.md`    | This file.                                                                                                                                                                |

Maintainer material, such as publishing history and release mechanics, belongs in CONTRIBUTING.md, not the README. npm and the Pi gallery display the README.

## 10. Voice and tone

### 10.1 Voice

The voice is the same everywhere: clear, calm, and exact, like a careful maintainer explaining something to a capable peer. The tone adapts to the section:

- Getting started is welcoming and brief.
- Reference material is precise and dense.
- Privacy and security are direct and factual.
- Troubleshooting names the cause, then the fix.

The rules:

1. **Lead with the outcome.** The first sentence is the description. The next paragraph shows a concrete result, as pi-tmux does: "a prompt about fixing authentication tests might produce `fix auth tests`."
2. **Talk to the reader.** Use "you", and the imperative for steps ("Install", "Run", "Set"). Call the extension by its name (pi-tmux), not "this plugin" or "we".
3. **Use the active voice and the present tense.** Write "pi-tmux renames the window", not "the window will be renamed".
4. **Keep it short.** Keep sentences to 25 words or fewer and introductory paragraphs to three sentences or fewer, with one idea per paragraph.
5. **Use plain words.** Write "use", not "utilize", and "start", not "initiate". Define each term the first time you use it, or link to a definition. Keep internal mechanics out of the introduction.
6. **Skip hype and filler.** Avoid "simply", "just", "easily", "powerful", "seamless", "robust", and "blazing". Don't use emojis or exclamation marks.
7. **State limits and data handling plainly, starting with what's allowed.** For example: "pi-otel exports metadata only. It never exports prompts, answers, tool arguments, or tool results."
8. **Name things consistently**, as in the table below. Put tools, commands, environment variables, files, and code in backticks. Write numbers as numerals with units (50 KB, 30 seconds), and dates in ISO format.
9. **Make commands copy-pasteable.** Use one code block per task, tag it `sh`, `json`, or `ts`, and write placeholders as `<name>`.
10. **Make links descriptive**, such as "see [Configuration](#configuration)". Never write "click here".
11. **Write titles as release notes.** A PR title or commit subject is a Conventional Commit type followed by a user-facing outcome. Write the outcome in the imperative mood and in lowercase, without a final period, in 72 characters or fewer. For example, write `feat(naming): keep window titles when you resume a session`, not `feat: update naming.ts`.

| Use                                                    | Instead of                               |
| ------------------------------------------------------ | ---------------------------------------- |
| Pi, Pi Durable, Node.js, npm, tmux, OpenTelemetry, A2A | pi, PI, node, NPM, TMUX, OTel (in prose) |
| extension (what Pi loads), package (what npm ships)    | plugin, add-on, module                   |
| tool (the model calls it), command (you type `/name`)  | function, action                         |
| install, remove, `/reload`                             | add, uninstall, restart                  |
| session, conversation                                  | chat, thread                             |
| model, provider                                        | LLM, AI (unless the distinction matters) |

### 10.2 Examples from the current READMEs

| Before                                                                                                                                                                         | After                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "A Pi extension that delegates tasks to separate Pi processes with isolated context windows. Extracted from Leo Cavalcante's dotfiles…"                                        | "Delegate tasks to isolated Pi subagents: single, parallel, chained, or in the background. Each subagent runs as its own Pi process with its own context window, so long investigations don't crowd your conversation." (The origin story moves to License.) |
| "Export model usage, timing, tool activity and lifecycle traces through OTLP/HTTP to your own collector. No replacement agent loop, tools, global OpenTelemetry registration…" | "pi-otel sends traces, metrics, and logs about model calls, timing, and tool activity to your own OpenTelemetry collector. It exports metadata only." (The list of limits moves to Privacy and security.)                                                    |
| "**Client:** an official-SDK A2A client with explicit endpoint trust and bounded responses. It does not import Pi."                                                            | "You can use the A2A client without Pi. It connects only to endpoints you configure and limits how much each response can return."                                                                                                                           |

### 10.3 README structure (MUST)

Every README uses the same headings in the same order. Optional sections have fixed places.

```text
# pi-<name>
<description: the same sentence as package.json and GitHub>
<badges: npm version · CD status · license>
<what you get, with one concrete example; 2–4 sentences>
<preview image (optional)>
## Contents              when the README is longer than about 150 lines
## Installation          pi install npm:@leocavalcante/pi-<name>, then /reload; requirements;
                         try it once with pi -e; install from GitHub; remove it
## Quick start           optional: the shortest path to a first result
## Usage                 a table of tools and commands, then examples
## How it works          optional
## Configuration         a table of variables or files, with defaults and descriptions
## Compatibility         "Requires Pi <min> or newer and Node.js 22.19 or newer.
                         Tested with Pi <tested> on Linux, macOS, and Windows."
## Privacy and security  what it reads, what leaves your machine, what it writes and where;
                         a link to SECURITY.md
## Troubleshooting       optional
## More Pi extensions    the shared table of extensions, copied verbatim from A.12
## Contributing          a link to CONTRIBUTING.md
## License               MIT; upstream notices; where the code came from, when relevant
```

Never pin a version in an install command, because Pi never updates npm packages installed at a pinned version.

`tests/readme.test.ts` checks that the README opens with the `package.json` description and that "More Pi extensions" matches A.12, so the extensions keep linking to each other.

## 11. GitHub settings

| Area          | Setting                                                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| About         | Description (§2), topics, and website (the gallery page)                                                                                                                                                                                                                     |
| Features      | Issues on. Wiki, Projects, and Discussions off.                                                                                                                                                                                                                              |
| Merging       | Squash merges only. The commit title comes from the PR title, and the message from the commit messages, which keeps the `Signed-off-by` lines. Turn on auto-merge, "always suggest updating", and deleting branches after merge.                                             |
| Sign-off      | Require sign-off on web commits.                                                                                                                                                                                                                                             |
| Code security | Dependabot alerts and security updates; secret scanning with push protection; private vulnerability reporting; CodeQL default setup. Once workflows exist, CodeQL also scans the `actions` language; a pull request analyzed before that needs a new commit to be rescanned. |
| Actions       | Read-only default token. Actions can't approve PRs. Actions must be pinned to full SHAs.                                                                                                                                                                                     |
| Environment   | `npm`, deployable from `main` only.                                                                                                                                                                                                                                          |
| Labels        | GitHub and Dependabot defaults, plus `breaking-change`, `needs-repro`, `pi-compat`, `release`, and `security`.                                                                                                                                                               |

**Rulesets:**

- **`main`** ([A.10](#a10-main-ruleset)):
  - No deletion or force push, and linear history.
  - Changes only through PRs: no approvals required, squash merges only, stale approvals dismissed, and review threads resolved.
  - Required checks `required` and `pr-title`, reported by GitHub Actions and up to date with `main`.
  - CodeQL results required, with no new errors or high-severity alerts.
  - No bypass.
- **`v*` tags:** no updates, force pushes, or deletion. Repository admins can bypass this rule to recover a failed release.

## 12. Security

- [ ] npm Trusted Publishing with provenance only; 2FA-only publishing; no tokens
- [ ] Actions pinned to full SHAs, enforced by the repository setting
- [ ] Least-privilege `permissions`; `id-token: write` only in the release job
- [ ] `persist-credentials: false`, `bun install --frozen-lockfile`, and dependency install scripts blocked
- [ ] actionlint and zizmor on workflows; gitleaks; GitHub secret scanning with push protection
- [ ] `bun audit --audit-level=high` blocks high/critical findings; `bun audit` and Dependabot surface all severities. Dependabot for `bun` and `github-actions`, grouped, with a 7-day cooldown (Pi packages exempt)
- [ ] CodeQL default setup, private vulnerability reporting, and deprecated `0.0.0-stage` bootstrap versions

## 13. Runtime conventions

- **Tools** use `snake_case` and start with the extension's short name (`a2a_send`, `subagent_jobs`).
- **Commands** are `/<name>` or `/<name>-<verb>` (`/a2a`, `/tmux-title`). New commands MUST start with the extension's name.
- **Environment variables** follow `PI_<NAME>_<SETTING>` (`PI_TMUX_MODEL`). Use an ecosystem's own variables where they exist, such as `OTEL_*`.
- **Files.** State and configuration go in a `<name>/` folder under Pi's agent directory (`getAgentDir()`, which honors `PI_CODING_AGENT_DIR`). Project files go under `.pi/`, and only after the user trusts the project. Existing file locations keep working.
- **Lifecycle:**
  - Do no work at import time; register everything in the factory.
  - Release timers, processes, and sockets on `session_shutdown`, and keep working after `/reload`.
  - If something the extension needs is missing, such as tmux or an OTLP endpoint, stay inactive and say so once. Never throw an error into Pi.
- **Privacy.** Conversation content never leaves the machine unless sending it is the documented feature. Limit output sizes and redact errors.
- **UI.** Use `ctx.ui.notify` for messages, and keep working in print and RPC modes.

## 14. Compatibility

- **Node.js:** 22.19.0 or newer, the same floor as Pi. CI tests that exact version and every supported major version.
- **Pi:** each README states the minimum version, which `engines.pi` declares and the `pi-min` job tests, and the tested version, which is the devDependency that Dependabot updates. Raising the minimum is a breaking change.
- **Bun:** 1.4.x, for development only.
- **Operating systems:** Linux, macOS, and Windows. Platform-specific features document what they skip.

## 15. Starting a new extension

pi-tmux is the reference implementation; copy the shared files ([A.1](#a1-shared-files)) from it.

1. Search npm and pi.dev/packages for the name.
2. Run `gh repo create leocavalcante/pi-<name> --public --clone` in `~/src`. Copy the shared files, then replace the names, description, topics, and the repository URL in `cliff.toml`.
3. Apply §11 ([A.11](#a11-settings-commands)).
4. Tag the first commit `v0.0.0`. Without that tag, semantic-release starts at 1.0.0.
5. Bootstrap npm once, because a trusted publisher needs an existing package:
   1. Run `npm login`, then publish `0.0.0-stage` from a clean `main`.
   2. Run `npm trust github @leocavalcante/pi-<name> --file cd.yaml --repo leocavalcante/pi-<name> --env npm --allow-publish`.
   3. Set publishing access to "require 2FA and disallow tokens".
   4. Run `npm deprecate @leocavalcante/pi-<name>@0.0.0-stage "Bootstrap placeholder; not a release."`
6. Merge the first `feat:` PR. `cd.yaml` publishes 0.1.0.
7. Add the extension to the table in [A.12](#a12-more-pi-extensions), then copy the updated standard and the section into every extension's repository and README.

## Appendix: reference files

### A.1 Shared files

- **Identical in every repository:** `.editorconfig`, `.gitattributes`, `.gitignore` ([A.14](#a14-gitignore)), `.prettierrc.json`, `bunfig.toml`, `eslint.config.mjs`, `.releaserc.json`, `.github/workflows/cd.yaml`, `.github/workflows/pr-title.yaml`, `.github/dependabot.yml`, `.github/pull_request_template.md`, `.github/CODEOWNERS`, `docs/pi-extension-standard.md`, and `tests/readme.test.ts`.
- **Identical except for named values:** `tsconfig.json` and `tests/tsconfig.json`, `cliff.toml` (repository URL), `SECURITY.md` (repository name, [A.13](#a13-securitymd)), and `AGENTS.md` (description and project notes, [A.9](#a9-agentsmd)).
- **Shared core plus repository-specific jobs:** `.github/workflows/ci.yaml`.

### A.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`tests/tsconfig.json` contains `{ "extends": "../tsconfig.json", "compilerOptions": { "types": ["bun", "node"] }, "include": ["."] }`. The SDK `tsconfig.build.json` extends the root file and sets `noEmit: false`, `rewriteRelativeImportExtensions`, `declaration`, `declarationMap`, `sourceMap`, `rootDir: "src"`, and `outDir: "dist"`.

### A.3 eslint.config.mjs

The reference copy from pi-otel. Tests may relax only the `no-unsafe-*`, `no-explicit-any`, and `no-non-null-assertion` rules, because they inspect untyped payloads. TypeScript scripts in `.github/scripts` get their own `tsconfig.json`.

```js
// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// OTLP fixture tests inspect dynamically shaped JSON; keep these relaxations test-only.
const testPayloadRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules)
    .filter(
      (name) =>
        name.startsWith("no-unsafe-") ||
        name === "no-explicit-any" ||
        name === "no-non-null-assertion",
    )
    .map((name) => [`@typescript-eslint/${name}`, "off"]),
);

export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bun", "bun:*"],
              message:
                "Pi runs extensions on Node.js. Use node:* APIs in src/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: [".github/scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/**/*.ts"],
    rules: testPayloadRules,
  },
  prettier,
);
```

### A.4 package.json (extension)

```json
{
  "name": "@leocavalcante/pi-<name>",
  "version": "0.0.0-development",
  "description": "<Verb-first sentence that names Pi.>",
  "keywords": [
    "pi-extension",
    "pi-package",
    "pi-coding-agent",
    "<domain topics>"
  ],
  "homepage": "https://github.com/leocavalcante/pi-<name>#readme",
  "bugs": { "url": "https://github.com/leocavalcante/pi-<name>/issues" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/leocavalcante/pi-<name>.git"
  },
  "license": "MIT",
  "author": "Leo Cavalcante (https://github.com/leocavalcante)",
  "type": "module",
  "files": ["src/", "CHANGELOG.md"],
  "scripts": {
    "check": "tsc -p tsconfig.json && tsc -p tests",
    "lint": "prettier --check . && eslint .",
    "format": "prettier --write . && eslint --fix .",
    "test": "bun run test:bun && bun run test:node",
    "test:bun": "bun test --timeout 30000",
    "test:node": "node --import jiti/register --test \"tests/**/*.node-test.ts\"",
    "verify": "bun run lint && bun run check && bun run test && bun audit --audit-level=high && publint && npm pack --dry-run"
  },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "devDependencies": { "<all exact>": "<x.y.z>" },
  "engines": { "node": ">=22.19.0", "pi": ">=<min>" },
  "packageManager": "bun@1.4.4",
  "publishConfig": { "access": "public", "provenance": true },
  "pi": {
    "extensions": ["./src/extension.ts"],
    "image": "https://raw.githubusercontent.com/leocavalcante/pi-<name>/main/.github/media/preview.png"
  }
}
```

SDK packages add `exports` (pointing to `dist/`), `build` and `prepack` scripts, `dist/` in `files`, and `bun run build` in `verify`.

### A.5 cd.yaml

```yaml
name: CD

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: cd
  cancel-in-progress: false

jobs:
  ci:
    uses: ./.github/workflows/ci.yaml
    # A called workflow can't request more than its caller grants. The weekly
    # canary in ci.yaml opens issues, so grant that here or the whole run fails.
    permissions:
      contents: read
      issues: write

  release:
    if: github.ref == 'refs/heads/main'
    needs: ci
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    environment: npm
    permissions:
      contents: write # tags and GitHub releases
      issues: write # release comments and failure issues
      pull-requests: write # "released in" comments
      id-token: write # npm Trusted Publishing and provenance
    env:
      NPM_CONFIG_IGNORE_SCRIPTS: "true"
    steps:
      - uses: actions/checkout@<sha> # v7.x
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@<sha> # v2.2.0, reads packageManager
      - uses: actions/setup-node@<sha> # v7.x
        with:
          node-version: 24
      - run: bun install --frozen-lockfile
      - run: bun run --if-present build
      - run: bunx --no-install semantic-release # runs on Node.js through its shebang
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### A.6 .releaserc.json

```json
{
  "branches": ["main"],
  "tagFormat": "v${version}",
  "plugins": [
    [
      "@semantic-release/commit-analyzer",
      {
        "preset": "conventionalcommits",
        "releaseRules": [
          { "breaking": true, "release": "minor" },
          { "type": "revert", "release": "patch" },
          { "type": "docs", "scope": "readme", "release": "patch" }
        ]
      }
    ],
    [
      "@semantic-release/exec",
      {
        "generateNotesCmd": "bunx --no-install git-cliff --unreleased --tag v${nextRelease.version} --strip all",
        "prepareCmd": "bunx --no-install git-cliff --tag v${nextRelease.version} --output CHANGELOG.md",
        "successCmd": "node .github/scripts/verify-published.mjs ${nextRelease.version}"
      }
    ],
    "@semantic-release/npm",
    ["@semantic-release/github", { "labels": ["release"] }]
  ]
}
```

Remove the `breaking` rule when the extension reaches 1.0. When a release fails, the GitHub plugin opens an issue labeled `release`; with its default label, `semantic-release`, which doesn't exist, GitHub rejects that issue. The devDependencies are `semantic-release`, `@semantic-release/commit-analyzer`, `@semantic-release/exec`, `@semantic-release/npm`, `@semantic-release/github`, `conventional-changelog-conventionalcommits`, and `git-cliff`, all with exact versions. `@semantic-release/npm` installs an npm CLI that supports trusted publishing; the release job runs it with lifecycle scripts disabled and builds explicitly beforehand.

`.github/scripts/verify-published.mjs` polls the registry for up to 15 minutes after publishing and fails the release if the version or its SLSA provenance doesn't appear. npm processes new versions before exposing them; pi-otel 0.1.4 took three minutes. pi-otel has the reference copy.

### A.7 cliff.toml (essentials)

```toml
[changelog]
header = "# Changelog\n\n"
body = '''
{% if version %}## [{{ version | trim_start_matches(pat="v") }}] - {{ timestamp | date(format="%Y-%m-%d") }}{% else %}## [Unreleased]{% endif %}
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group | striptags | trim }}
{% for commit in commits -%}
- {% if commit.breaking %}**Breaking:** {% endif %}{{ commit.message | split(pat="\n") | first | upper_first }}
{% endfor %}
{% endfor %}
'''
trim = true

[git]
conventional_commits = true
filter_unconventional = true
protect_breaking_commits = true
use_branch_tags = true
tag_pattern = '^v[0-9]+\.[0-9]+\.[0-9]+$'
commit_preprocessors = [
  { pattern = '\(#([0-9]+)\)', replace = '([#${1}](https://github.com/leocavalcante/pi-<name>/pull/${1}))' },
]
commit_parsers = [
  { field = "breaking", pattern = "true", group = "<!-- 0 -->Breaking changes" },
  { message = "^feat", group = "<!-- 1 -->Features" },
  { message = '^fix\(deps\)', group = "<!-- 4 -->Dependencies" },
  { message = "^fix", group = "<!-- 2 -->Fixes" },
  { message = "^perf", group = "<!-- 3 -->Performance" },
  { message = "^revert", group = "<!-- 5 -->Reverts" },
  { message = '^docs\(readme\)', group = "<!-- 6 -->Documentation" },
  { message = ".*", skip = true },
]
```

### A.8 dependabot.yml

```yaml
version: 2
updates:
  - package-ecosystem: bun
    directory: /
    schedule:
      { interval: weekly, day: monday, time: "09:00", timezone: Etc/UTC }
    open-pull-requests-limit: 5
    versioning-strategy: increase
    commit-message: { prefix: "fix(deps)", prefix-development: "chore(deps)" }
    cooldown: { default-days: 7, exclude: ["@earendil-works/*"] }
    ignore:
      - dependency-name: "@types/node"
        update-types: ["version-update:semver-major"]
      - dependency-name: "typescript" # until typescript-eslint supports 7.x
        update-types: ["version-update:semver-major"]
    groups:
      pi: { patterns: ["@earendil-works/*", "typebox"] }
      lint:
        {
          patterns:
            [
              "eslint",
              "@eslint/*",
              "typescript-eslint",
              "prettier",
              "eslint-config-prettier",
            ],
        }
      release:
        {
          patterns:
            [
              "semantic-release",
              "@semantic-release/*",
              "conventional-changelog-*",
              "git-cliff",
            ],
        }
      dev: { dependency-type: development, update-types: [minor, patch] }
  - package-ecosystem: github-actions
    directory: /
    schedule:
      { interval: weekly, day: monday, time: "09:00", timezone: Etc/UTC }
    commit-message: { prefix: "ci(deps)" }
    cooldown: { default-days: 7 }
    groups:
      actions: { patterns: ["*"] }
```

### A.9 AGENTS.md

```markdown
# AGENTS.md

pi-<name>: <description>

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs every check CI runs.
- `bun run test:bun` and `bun run test:node` run one test lane.
- `bun run format` applies Prettier and ESLint fixes.
- `pi -e ./src/extension.ts` tries the checkout in Pi.

## Rules

- Follow docs/pi-extension-standard.md.
- Write Conventional Commits. The PR title becomes the release note (standard §10, rule 11).
- Sign off every commit (`git commit -s`). Never add Co-Authored-By.
- Never bump the version, edit CHANGELOG.md, create tags or releases, or publish. cd.yaml does that.
- Code in src/ runs on Node.js inside Pi: use `node:*` APIs, never Bun APIs.
- Keep Pi host packages, such as `@earendil-works/pi-coding-agent` and `typebox`, as `"*"` peer dependencies, never dependencies.
- Tests make no network or paid model calls.
- Update README.md and CONTRIBUTING.md with every behavior change, in the voice from standard §10.

## Project notes

<architecture, test lanes, external tools, known quirks>
```

### A.10 main ruleset

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] }
  },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true,
        "allowed_merge_methods": ["squash"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "required", "integration_id": 15368 },
          { "context": "pr-title", "integration_id": 15368 }
        ]
      }
    },
    {
      "type": "code_scanning",
      "parameters": {
        "code_scanning_tools": [
          {
            "tool": "CodeQL",
            "alerts_threshold": "errors",
            "security_alerts_threshold": "high_or_higher"
          }
        ]
      }
    }
  ]
}
```

### A.11 Settings commands

```sh
R=leocavalcante/pi-<name>
gh repo edit "$R" --description "<description>" --homepage "https://pi.dev/packages/@$R" \
  --enable-issues --enable-wiki=false --enable-projects=false --enable-discussions=false \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --enable-auto-merge --allow-update-branch
gh api -X PATCH "repos/$R" -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=COMMIT_MESSAGES -F web_commit_signoff_required=true
gh api -X PUT "repos/$R/topics" -f 'names[]=pi-extension' -f 'names[]=pi-package' -f 'names[]=pi-coding-agent' # …
gh api -X PUT "repos/$R/vulnerability-alerts"
gh api -X PUT "repos/$R/automated-security-fixes"
gh api -X PUT "repos/$R/private-vulnerability-reporting"
gh api -X PATCH "repos/$R/code-scanning/default-setup" -f state=configured   # after deleting any codeql workflow
gh api -X PUT "repos/$R/environments/npm" --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST "repos/$R/environments/npm/deployment-branch-policies" -f name=main -f type=branch
gh api -X POST "repos/$R/rulesets" --input ruleset-main.json   # once ci.yaml is on main (A.10)
gh api -X POST "repos/$R/rulesets" --input ruleset-tags.json
gh api -X PUT "repos/$R/actions/permissions" -F enabled=true -f allowed_actions=all -F sha_pinning_required=true   # once every action is pinned
```

### A.12 More Pi extensions

Every README carries this section verbatim, between Troubleshooting and Contributing. Each row repeats the extension's `package.json` description.

```markdown
## More Pi extensions

Each extension does one job, and all of them share the same conventions for code, tests, and releases. Combine the ones you need:

| Extension                                                     | What it does                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [pi-a2a](https://github.com/leocavalcante/pi-a2a)             | Talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.            |
| [pi-otel](https://github.com/leocavalcante/pi-otel)           | Observe Pi sessions and Pi Durable agents with OpenTelemetry, exporting metadata only.    |
| [pi-subagents](https://github.com/leocavalcante/pi-subagents) | Delegate tasks to isolated Pi subagents: single, parallel, chained, or in the background. |
| [pi-tmux](https://github.com/leocavalcante/pi-tmux)           | Name tmux windows after your current Pi task and mark the ones waiting for your input.    |

Install any of them with `pi install npm:@leocavalcante/<extension>`, then run `/reload`.
```

### A.13 SECURITY.md

```markdown
# Security policy

## Supported versions

Only the latest release receives security fixes. Upgrade before you report an issue, because older versions may still be affected.

## Report a vulnerability

Report suspected vulnerabilities or accidental credential exposure privately through [GitHub's vulnerability reporting form](https://github.com/leocavalcante/pi-<name>/security/advisories/new). Don't open a public issue, discussion, or pull request for them.

Include:

- the affected pi-<name> version, your Pi and Node.js versions, and your operating system
- what an attacker can do, and the steps to reproduce it, when it's safe to share them

Do not include credentials, API keys, access tokens, private endpoints, prompts, session data, attachments, logs, or project files. Use synthetic or redacted examples instead.

Please give the maintainer time to investigate and release a fix before you disclose the issue publicly.

## Exposed credentials

If a credential was exposed, revoke or rotate it with its provider first, then report how it was exposed. Never include the credential itself.
```

### A.14 .gitignore

```gitignore
# Dependencies and build output
node_modules/
dist/
coverage/
*.tgz

# Generated at release time
CHANGELOG.md

# Logs and local session records
*.log
*.jsonl

# Machine-local state, credentials, and keys
.env
.env.*
!.env.example
.npmrc
.netrc
.pi/
.pi-durable/
/auth/
/data/
/private/
/state/
**/auth.json
**/credentials*.json
**/*service-account*.json
*.pem
*.key
*.p12
*.pfx
id_rsa*
id_ed25519*

# Local databases
*.sqlite
*.sqlite-*
*.db
*.db-*

# Operating system files
.DS_Store
```
