# AGENTS.md

pi-a2a: talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.

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

### Layout

- `src/extension.ts` registers the Pi tools and `/a2a` command.
- `src/client.ts` wraps the official A2A client with endpoint trust, credential, timeout, and response-size checks.
- `src/durable.ts`, `src/server.ts`, `src/documents.ts`, and `src/push.ts` implement the Pi Durable adapter, HTTP handler, bounded document input, and durable push delivery.
- `src/observation.ts`, `src/progress.ts`, `src/peers.ts`, and `src/durable-tools.ts` implement Pi history recovery, progress, peer identity, and outbound delegation.
- `tests/*.test.ts` is the Bun lane. `tests/*.node-test.ts` is the Node.js lane, including extension-load and Durable storage/recovery tests.
- `examples/` contains the model-free echo agent and mesh provisioning example.

### Boundaries to preserve

- Preserve the client's explicit endpoint-origin checks, HTTPS-by-default and loopback exception, redirect rejection, and credential checks. Agent Cards cannot grant trust to new origins.
- Keep responses, text, attachments, status, errors, and artifact metadata bounded. Never forward remote diagnostic text or download artifact URLs.
- Preserve message-ID bindings to the same input, context, and task. Correlate observed task and stream-event IDs with saved receipts; do not treat a successful send RPC as task success.
- Persist Pi history receipts before external sends. Persist the Durable send-attempt marker before sending, admission and message/task bindings in the same Harness commit, and push delivery intent before POST. Do not automatically repeat an uncertain send or a pending callback with changed bytes.
- Keep authenticated peer identity separate from owner identity. Peer admission must remain idle-only and committed atomically; a peer must not gain owner access through a shared conversation.
- The library and examples must not contain machine-local agent configuration, credentials, private Harness content, or domain profiles.
