# AGENTS.md

pi-a2a: talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.

## Layout

- `src/extension.ts` registers the Pi tools and `/a2a` command.
- `src/client.ts` wraps the official A2A client with endpoint trust, credential, timeout, and response-size checks.
- `src/durable.ts`, `src/server.ts`, `src/documents.ts`, and `src/push.ts` implement the Pi Durable adapter, HTTP handler, bounded document input, and durable push delivery.
- `src/observation.ts`, `src/progress.ts`, `src/peers.ts`, and `src/durable-tools.ts` implement Pi history recovery, progress, peer identity, and outbound delegation.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.ts` is the Node.js lane, including extension-load and Durable storage/recovery tests.
- `examples/` contains the model-free echo agent and mesh provisioning example.

## Commands

- `bun install --frozen-lockfile` installs dependencies.
- `bun run verify` runs local lint, type, test, package, and dependency-audit checks.
- `bun run lint`, `bun run format`, and `bun run check` lint, format, and type-check the project.
- `bun run test` runs both test lanes; use `bun run test:bun` or `bun run test:node` for one lane.
- `bun run check:package` builds and validates the npm package contents.
- `pi -e ./src/extension.ts` loads this checkout in Pi.

## Rules

- Follow `docs/pi-extension-standard.md` and keep user documentation in the voice from its §10.
- Write Conventional Commits. PR titles are user-facing release notes, imperative and lowercase, at most 72 characters, with no final period.
- Sign off every commit with `git commit -s`. Never add a `Co-Authored-By` trailer.
- Never bump the version, edit the generated changelog, create tags or releases, or publish. The CD workflow does that.
- Keep Pi host packages in `peerDependencies` with version `"*"`, never in `dependencies`.
- Code in `src/` runs on Node.js inside Pi. Use `node:*` APIs, never Bun APIs.
- Tests must not make paid model calls. Use synthetic messages, faux providers, isolated stores, and loopback servers.

## Security boundaries

- Preserve the client's explicit endpoint-origin checks, HTTPS-by-default and loopback exception, redirect rejection, and credential checks. Agent Cards cannot grant trust to new origins.
- Keep responses, text, attachments, status, errors, and artifact metadata bounded. Never forward remote diagnostic text or download artifact URLs.
- Preserve message-ID bindings to the same input, context, and task. Correlate observed task and stream-event IDs with saved receipts; do not treat a successful send RPC as task success.
- Persist Pi history receipts before external sends. Persist the Durable send-attempt marker before sending, admission and message/task bindings in the same Harness commit, and push delivery intent before POST. Do not automatically repeat an uncertain send or a pending callback with changed bytes.
- Keep authenticated peer identity separate from owner identity. Peer admission must remain idle-only and committed atomically; a peer must not gain owner access through a shared conversation.
- Update README.md and CONTRIBUTING.md with behavior changes. The library and examples must not contain machine-local agent configuration, credentials, private Harness content, or domain profiles.
