# Contributing

## Development

Use Bun 1.4.4 and Node.js 22.19.0 or newer. Development uses TypeScript 6.0.3. Pi loads extensions on Node.js, so code in `src/` uses Node.js APIs, not Bun APIs.

```sh
bun install --frozen-lockfile
bun run verify
git diff --check
```

`verify` checks formatting and lint, then type-checks the source, tests, examples, and CI scripts. It runs the Bun and Node.js test lanes, builds the package, validates it in an isolated consumer, checks package metadata, and audits dependencies.

- `bun run lint` runs Prettier and ESLint with typescript-eslint `strictTypeChecked`; `bun run format` applies their fixes. Disable a rule only on the line that needs it, with a reason. Tests may relax unsafe-any, explicit-`any`, non-null-assertion, and `require-await` rules because they inspect untyped protocol payloads and use Promise-shaped test doubles.
- Audits block high and critical vulnerabilities. Run `bun audit` to review every severity.
- `bun run check` type-checks source, tests, examples, and CI scripts. `bun run check:package` builds, updates the ignored changelog, checks package metadata, and tests the package contents.

```sh
bun run test:bun
bun run test:node
pi -e ./src/extension.ts
```

- **Bun lane.** `test:bun` builds `dist/` first because the mesh provisioning test runs the published example, which imports it. The tests use the `node:test` API, which Bun runs. Converting them to `bun:test` is follow-up work.
- **Node.js lane.** `test:node` covers the extension load test, SIGKILL recovery, and Durable tests that use Pi Durable's `node:sqlite` storage. Bun emulates `node:sqlite`; on macOS, reopening a database fails under that emulation. Production code runs on Node.js. The recovery fixture loads TypeScript through jiti, as Pi does.
- **No paid model calls.** Tests use synthetic messages, isolated stores, faux providers, and loopback servers.
- **Skipped tests.** Two tests need the official [A2A CLI](https://github.com/a2aproject/a2a-cli) on `PATH`; without it, they skip.

Tests cover the official client against Durable and a non-Pi official-SDK peer. They exercise real TUI-bound SDK sessions with delayed HTTP/SSE replies, command completion, busy-session ordering, and disk-backed reopen and lost-injection recovery. They also test branch-local deduplication, reconnect limits, request conflicts, SQLite recovery, interrupted waits, and scoped cancellation. Further coverage includes task pagination, ownership, protocol errors, output bounds, and credential-origin checks. Passing tests are not official A2A certification or evidence of live OAuth, every third-party deployment, paid-model quality, or production high availability.

The library and examples must not contain machine-local agent configuration, credential exports, private Harness content, or domain profiles. Deployment cutovers belong to their owning applications, not this public repository.

When you change workflows, run the same checks as CI on Linux:

```sh
bash .github/scripts/check-workflows.sh
uvx --from zizmor==1.32.0 zizmor --offline .github
```

## Pi Durable compatibility

The optional peers `@earendil-works/chord` and `@earendil-works/pi-durable` accept any version, like the other Pi host packages. Chord 1.5.2 removed `Context` and `JsonValue` from its root export, so import Chord types from the `@earendil-works/chord/context` and `@earendil-works/chord/delta` subpaths. Both Chord 1.5.0 and 1.5.2 provide them. CI tests the minimum Pi (1.5.0) and the development dependency version; the weekly Pi canary reports when the latest release diverges.

## Commits and pull requests

Use Conventional Commits and sign off commits with `git commit -s`. Never add a `Co-Authored-By` trailer.

PR titles become squash commit subjects and release notes, so keep them user-facing. Use at most 72 characters and no final period. Write the outcome in the imperative mood and lowercase.

## Automatic releases

Don't edit the development version, create release tags, or publish from your machine. On pushes to `main`, `.github/workflows/cd.yaml` runs CI, then semantic-release publishes releasable changes through npm Trusted Publishing, with provenance. Merging a releasable Conventional Commit is the only release action.

- `feat` releases a minor version; `fix`, `perf`, and `revert` release a patch.
- `docs(readme)` releases a patch, so npm and the Pi gallery receive README changes.
- While the package is below 1.0, breaking changes release a minor version. Remove that rule when releasing 1.0.
- CI, toolchain, and maintainer documentation changes don't release.

The version in `package.json` stays `0.0.0-development`. semantic-release sets the real version only in its temporary workspace and never commits back to `main`.

git-cliff generates both the GitHub release notes and the `CHANGELOG.md` shipped in the package. To preview the changelog locally, run `bun run changelog`.

The release job uses Node.js 24 and the npm CLI installed by `@semantic-release/npm`, which supports OIDC. It disables lifecycle scripts while publishing and runs the build explicitly beforehand. npm processes each new version for a few minutes before exposing it. The release job polls for up to 15 minutes to confirm the version and its provenance.

### One-time publisher setup

The package already exists on npm. Don't bootstrap or republish any existing version. Version 0.4.0 was published by hand, without provenance; tag `v0.4.0` matches its published sources.

1. Make sure the workflow is named `cd.yaml` and its release job uses the GitHub environment `npm`.
2. Log in to npm interactively. Remove any trusted publisher left over from the old `publish.yml` workflow, then add one for `cd.yaml`:

   ```sh
   npm login
   npm trust list @leocavalcante/pi-a2a
   npm trust github @leocavalcante/pi-a2a \
     --file cd.yaml --repo leocavalcante/pi-a2a --env npm --allow-publish
   ```

   - Each `npm trust` command asks for a 2FA approval in the browser.
   - Don't pass `--json`: npm then withholds the approval link until the command ends.
   - A new trusted publisher expires unless it completes a publish within 2 days, so create it right before merging a releasable change.

3. After the first trusted publish succeeds, set npm publishing access to require 2FA and disallow tokens. Don't create an `NPM_TOKEN` secret.
4. The GitHub `npm` environment allows deployments from `main` only.
5. Verify the release:

   ```sh
   npm view @leocavalcante/pi-a2a version dist.attestations
   ```

### Recovering a partial release

Check npm before retrying a failed release. semantic-release pushes the tag before publishing, so a normal re-run may treat that version as already released.

- **The version is missing from npm:** find out why publishing failed. Once it's fixed, an administrator may delete only the failed release tag and re-run CD on `main`.
- **The version exists on npm:** don't delete its tag or try to republish it because npm versions are immutable. Verify its provenance, restore any missing GitHub release from the tag, and release a new version for package fixes.
- **The version was published without provenance:** treat this as a failed release. Investigate OIDC and publish a new, attested version; republishing can't repair an existing npm version.
