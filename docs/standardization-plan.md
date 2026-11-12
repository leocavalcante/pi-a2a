# Standardization plan: pi-a2a

Status: done except gallery media, 2026-11-12. Target: [Pi extension standard v1](pi-extension-standard.md). Delete this file once every step is done.

## Progress

- Step 0a is complete. The npm 0.4.0 tarball matches commit `a5f3817` file for file (`src`, `examples`, README, LICENSE, and `package.json`). Tag `v0.4.0` and its [GitHub release](https://github.com/leocavalcante/pi-a2a/releases/tag/v0.4.0) record that it was published by hand without provenance.
- Step 0b is complete: identity, topics, website, merge settings, security features, CodeQL default setup, labels, and the `npm` environment.
- Step 1 adds Bun, TypeScript 6, and CI. Three findings changed the plan:
  - **Step 3 was dropped, then revived.** `@earendil-works/chord` 1.5.2 removed `JsonValue` and `Context` from its root export. Both versions also export them from the `context` and `delta` subpaths, so importing from there supports 1.5.0 and 1.5.2, and the peers become `*`.
  - The `HeadersInit` type came only from the DOM library that TypeScript added by default. `src/client.ts` now derives the same type from Node's global `Headers`.
  - The tests use the `node:test` API with `t.after()`. Bun runs them through its `node:test` support, so they type-check against Node types only. Converting them to `bun:test` is follow-up work.
  - The Durable tests that reopen SQLite through Pi Durable's `node:sqlite` storage fail on macOS under Bun's emulation, with "disk I/O error". In production that code runs on Node.js, so seven files (38 tests) moved to the Node.js lane.
- Steps 1–2 merged as #1 and #2. The first automated release was 0.4.1 (#3, `docs(readme): install from npm by default`), with provenance.
- Step 3 merged as #10 and released **0.4.2**: Chord types come from subpaths, the Chord and Pi Durable peers are `*`, and development uses Pi 1.5.2. CI still tests Pi 1.5.0.
- Steps 4–6 and 8 merged as #7 (Prettier), #9 (`.git-blame-ignore-revs`), and #12 (typescript-eslint `strictTypeChecked` plus `noUncheckedIndexedAccess`, with behavior-preserving fixes only).
- Step 7 merged as #14 and released **0.4.3**: the README follows the shared structure and voice, and SECURITY, AGENTS, issue forms, the PR template, and CODEOWNERS are in place.
- Shared conventions synced: #13 (`engines.pi` read by `pi-min`, the test-tools hook, `--if-present` builds, the `release` label for release-failure issues) and #15 (`pi-pins.json` support in `install-pi.ts`).
- npm: `0.0.0-stage` is deprecated, and publishing requires 2FA and disallows tokens.
- **Remaining:** add `pi.image` and upload the matching social preview by hand. Then delete this file.

pi-a2a is the second repository, after the pilot. Like pi-otel, it has no CI to migrate, but its npm release has no matching tag, and that has to be fixed first.

## Target identity

| Field                   | Value                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Description             | Talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.                                                                   |
| Topics and npm keywords | `pi-extension` `pi-package` `pi-coding-agent` `pi-durable` `a2a` `a2a-protocol` `agent-to-agent` `agent-communication` `multi-agent` `ai-agents` |
| Website                 | https://pi.dev/packages/@leocavalcante/pi-a2a                                                                                                    |
| Kind                    | Extension and SDK: Pi loads `src/extension.ts`; Node.js consumers import `client`, `durable`, and `server` from `dist/`                          |
| Pi versions             | Minimum 1.5.0; tested with 1.5.2                                                                                                                 |

## Where it stands

- **No git tags or GitHub releases.** npm 0.4.0 was published from a laptop, without provenance and without a recorded commit. With no tag, semantic-release would publish 1.0.0 next.
- **No CI on pull requests or pushes.** `publish.yml` is started by hand, uses unpinned `@v4` actions, and has never run.
- **GitHub settings:**
  - The About text matches npm, but there are no topics or website.
  - Wiki and Projects are on, all three merge methods are allowed, and branches aren't deleted after merge.
  - Dependabot alerts and private vulnerability reporting are off.
  - `main` has no branch protection.
- **`package.json`:**
  - The repository URL lacks `git+`, and there is no `homepage` or `bugs`.
  - The author is `leocavalcante`.
  - The optional peers `@earendil-works/chord` and `@earendil-works/pi-durable` are pinned to exactly `1.5.0`.
- **Toolchain:** npm, TypeScript 5.9.3, tests through `node --import tsx --test` (20 files), 2-space indentation, and no formatter or linter.
- **Docs:** the 290-line README leads with a git install and contains two maintainer sections: "npm publication" and "Development and verification".
- **Measured:**
  - TypeScript 6.0.3 reports no errors; `noUncheckedIndexedAccess` adds 97.
  - `bun test --timeout 30000` passes 118, skips 2, and fails 1. The failure is the SIGKILL recovery test in `tests/recovery.test.ts`, which depends on Node.js process behavior.

## Steps

Each step is one pull request unless marked otherwise. "Release" is what `cd.yaml` publishes after the merge.

| #   | Change                                                    | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Release |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0a  | _Tag_                                                     | <ul><li>Compare `npm pack @leocavalcante/pi-a2a@0.4.0` with `git archive a5f3817`. 0.4.0 was published 2026-11-07 22:41 UTC, about an hour after that commit.</li><li>If they match, run `git tag -a v0.4.0 a5f3817 -m v0.4.0`, push the tag, and create a GitHub release that says it was published by hand without provenance.</li><li>If they don't match, tag the closest commit and say so in the release.</li><li>**Required before step 2.**</li></ul>                                                                                                                                | —       |
| 0b  | _Settings_                                                | Standard A.11 except rulesets.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —       |
| 1   | `build: adopt the Bun and TypeScript 6 toolchain with CI` | <ul><li>`bun.lock` replaces `package-lock.json`; tsx is removed.</li><li>19 test files move to the Bun lane. The SIGKILL recovery case moves to `tests/recovery.node-test.ts`, keeping `--test-concurrency=1`.</li><li>Add jiti and `tests/load.node-test.ts`.</li><li>TypeScript 6.0.3 with the shared tsconfig; keep `tsconfig.build.json`.</li><li>Add `ci.yaml` (`pi-min` 1.5.0, build step), `pr-title.yaml`, and `dependabot.yml`.</li><li>Delete `publish.yml`: it can't run without `package-lock.json`, and step 2 replaces it.</li></ul> Then create the `main` and `v*` rulesets. | none    |
| 2   | `ci: release to npm automatically from main`              | Add `cd.yaml`, `.releaserc.json`, and `cliff.toml`. Set the version to `0.0.0-development` and add `CHANGELOG.md` to `files` and `.gitignore`. Complete the cutover checklist first.                                                                                                                                                                                                                                                                                                                                                                                                         | none    |
| 3   | `fix(durable): support Chord and Pi Durable 1.5.2`        | Import Chord types from the `context` and `delta` subpaths, widen the Chord and Pi Durable peers to `*`, and test with 1.5.2. See Progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | patch   |
| 4   | `style: format with Prettier`                             | Formatting changes only. CI starts running `prettier --check`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | none    |
| 5   | `chore: ignore the formatting commit in git blame`        | `.git-blame-ignore-revs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none    |
| 6   | `chore: lint with typescript-eslint`                      | Add `eslint.config.mjs` and apply the fixes that don't change behavior. Each real bug ESLint finds gets its own `fix:` PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none    |
| 7   | `docs(readme): adopt the shared structure and voice`      | <ul><li>README:<ul><li>Lead with `pi install npm:@leocavalcante/pi-a2a`.</li><li>Add a Usage table for the `a2a_agents`, `a2a_send`, `a2a_get_task`, and `a2a_cancel_task` tools and the `/a2a` command.</li><li>Keep the note about the unrelated unscoped package.</li><li>Move "npm publication" and "Development and verification" to CONTRIBUTING.</li></ul></li><li>Add SECURITY, AGENTS, the issue forms, the PR template, CODEOWNERS, and the standard.</li><li>`package.json` metadata: homepage, bugs, author, and `git+https` repository URL.</li></ul>                           | patch   |
| 8   | `refactor: check indexed access`                          | Turn on `noUncheckedIndexedAccess` and fix the 97 sites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | none    |
| 9   | _After the releases_                                      | Deprecate `0.0.0-stage`. Add `pi.image` and the social preview. Turn on `sha_pinning_required`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | —       |

## Cutover checklist (before merging step 2)

- [ ] Tag `v0.4.0` exists (step 0a), so semantic-release continues from 0.4.0.
- [ ] Run `npm login`, then `npm trust list @leocavalcante/pi-a2a`. The old manual workflow may have an entry.
- [ ] Run `npm trust github @leocavalcante/pi-a2a --file cd.yaml --repo leocavalcante/pi-a2a --env npm --allow-publish`.
- [ ] The `npm` environment exists, with `main` as its only deployment branch.
- [ ] Merge step 2. Nothing is released, because there are no releasable commits since `v0.4.0`.
- [ ] Merge step 3, then check:
  - [ ] Merge step 7 (`docs(readme)`), which releases 0.4.1. Then: tag `v0.4.1` exists.
  - [ ] npm 0.4.1 has provenance.
  - [ ] The GitHub release has notes.
  - [ ] The tarball contains `CHANGELOG.md`, `dist/`, `src/`, and `examples/`.

## Notes and risks

- **Without the v0.4.0 tag, the first automated release would be 1.0.0.** Step 0a is a hard prerequisite.
- **Tests stay in sequence.** The tests share ports and processes, so they run one at a time today. The Bun lane runs files one after another by default, and the Node.js lane keeps `--test-concurrency=1`.
- **Published files.** `examples/` stays published; the standard allows examples in SDK packages. `docs/pi-only-async-completion-plan.md` stays out of the package.
- **Naming.** The `/a2a` command and the `a2a_*` tools already follow §13.

## Rollout across the extensions

This section is identical in every repository's plan.

**Order:**

1. Retire pi-ttyd.
2. pi-otel, the pilot, which also ships its missing fix.
3. pi-a2a.
4. pi-tmux, which becomes the reference implementation.
5. pi-subagents, which has the largest test migration.

Finish a repository's steps 1–3 before starting the next one, so each migration builds on the last.

**npm account (once, interactive):**

1. Run `npm login`, then `npm trust list <package>` for each package to record today's trusted publishers.
2. At each repository's step 2, run `npm trust github <package> --file cd.yaml --repo leocavalcante/<repo> --env npm --allow-publish`. This replaces any `publish.yml` entry.
3. Set each package's publishing access to "require 2FA and disallow tokens".
4. Run `npm deprecate <package>@0.0.0-stage "Bootstrap placeholder; not a release."`

**Retire pi-ttyd.** It has no open issues or pull requests, and about 17 downloads a week.

1. Merge `docs: mark pi-ttyd as unmaintained`. The README opens with: "**pi-ttyd is no longer maintained.** Published versions stay installable, but they won't get updates or security fixes. Remove it with `pi remove npm:pi-ttyd`."
2. Run `npm deprecate pi-ttyd "pi-ttyd is no longer maintained. Remove it with: pi remove npm:pi-ttyd"`.
3. Run `gh repo edit leocavalcante/pi-ttyd --description "Unmaintained. Set ttyd tab titles, notify you when Pi is ready, and accept dropped images."`.
4. Run `gh repo archive leocavalcante/pi-ttyd --yes`.
