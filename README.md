# pi-a2a

Talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.

- **Client:** an official-SDK A2A client with explicit endpoint trust and bounded responses. It does not import Pi.
- **Durable adapter:** attach A2A to an existing Harness and its conversations. Task identities, message receipts and results live in that Harness's storage.
- **Pi extension:** tools and `/a2a` commands for talking to configured Durable or non-Pi A2A agents.
- **Durable tools:** let a Durable agent delegate to another A2A agent through the same client.

The npm package name is `@leocavalcante/pi-a2a`; the unrelated unscoped `pi-a2a` package is not this project.

MIT licensed. Built on the [official A2A JS SDK](https://github.com/a2aproject/a2a-js), not a handwritten replacement for its wire types or dispatch.

## Compatibility and scope

Node **22.19+**, Pi coding agent / Pi Durable **1.5.0**, official `@a2a-js/sdk` **1.3.0**, A2A protocol **1.0**. Durable is experimental; this is a version-pinned integration, not a promise of compatibility with every Pi release.

The server exposes **JSON-RPC over HTTP**, Agent Card discovery, send/get/list tasks, cursor pagination, follow-ups, status/artifact streaming and subscription. The client negotiates **JSON-RPC or HTTP+JSON/REST** through the official SDK. It can talk to non-Pi implementations using those interfaces. gRPC and v0.3 compatibility are not enabled here. Authentication, supported media and capabilities still have to match.

The Durable adapter accepts **text/plain**, up to **8192 UTF-8 bytes**. Opt-in `images: true` also accepts up to four inline JPEG/PNG images of at most 1 MiB each. It never fetches attachment URLs, opens host files or executes instructions from an Agent Card. Opt-in A2A 1.0 push notifications require an explicit callback-origin allowlist and application-owned pump lifecycle. Extended cards, protocol extensions and reference-task processing remain unsupported. Streaming reports task state, fixed progress descriptions, and committed final artifacts; it does not promise provider-token streaming or byte-for-byte replay of an old stream.

## Private discovery and delegation

Durable owners can discover and contact any registered A2A peer without hard-coded pairings, a coordinator Harness or a custom client. An ordinary A2A client submits its request to one agent; that agent chooses collaborators through tools and produces its normal A2A task/result. LabAgents is not required.

Install `createA2ATools({self: "alpha", guard: guardPublication})` in the existing registry. Its generic tools are `a2a_agents` (live Agent Card roles, skills, media and streaming capabilities, with pagination), `a2a_send` (text delegation and optional waiting), and `a2a_get_task` (read/observe existing work). Discovery uses registered endpoints from the existing `AgentConfig`, not network scans. Cards and replies are remote data, never instructions or approval. The directory is re-read for each operation: registering another endpoint does not require workflow or prompt changes. Missing explicitly selected configuration is an error, not an empty directory.

For trusted agents belonging to one human owner, use `peerBearerAuth(readOwnerToken, "alpha-owner")` and adapter options `mesh: {name: "alpha", owner: {userId: "alpha-owner", tenant: ""}}`. The host conversation resolver must accept only its owner and authenticated `peerName(identity.userId)` identities, returning its existing root or a fresh conversation for a new context. The helper authenticates each peer separately using `incomingBearerTokenFile` references in that host's directory, while outbound calls use `bearerTokenFile`/`bearerTokenEnv`. It never distributes the human owner's token or provider credentials. Protect non-A2A status/admin routes separately; a valid peer is not their owner.

Peer requests receive authenticated caller provenance in model input and standard task metadata under `pi-a2a.peer`. Peers can retrieve only their own tasks and cannot adopt owner legacy receipts. The configured human owner may read/list its host's peer results (including task-bound file artifacts), but this does not permit cross-identity message replay or cancellation. This is a trusted, single-human-owner mesh, not isolation between unrelated users sharing one conversation.

**Busy recipients:** peer admission requires an idle existing conversation, checked in the admission commit. A busy recipient returns standard `UNSUPPORTED_OPERATION` ErrorInfo with `metadata: {input: "peer", admission: "rejected", busy: "true"}`. No peer input is queued. This prevents synchronous cross-agent wait cycles on single-conversation owners without aborting active work. Owner messages retain their normal follow-up behavior or the host's explicit `whenBusy: "steer"` setting. A rejected peer request can be attempted later under the same identity; this is distinct from an uncertain send.

Send tools retain their target, attempt marker, acknowledgement and bounded result in native Durable task memos. Reopening after a confirmed acknowledgement resumes task observation rather than sending again; an attempted send without an acknowledgement returns `DELIVERY_UNCERTAIN` and is never automatically resubmitted, even for peers that do not deduplicate. Endpoint changes stop pending observation under that alias. Advertised streaming uses task subscriptions and an authoritative final task read; a failed advertised stream is not replaced with polling. Non-streaming peers retain ordinary GetTask observation. Local cancellation never calls remote CancelTask.

Tool outputs preserve bounded text plus credential-free, approved-origin URL artifact references; files are not downloaded. Original artifact ownership/authentication remains with the producing agent. Host guards scan outgoing/incoming projections; declared messaging credential values are additionally withheld by the shared tools. No private profile or transcript is automatically forwarded, no domain permission is changed, and no remote model usage is fabricated or counted twice.

`examples/mesh/provision.mjs` prepares separate, directional peer credentials and per-agent configuration outside Git. It preserves existing keys on rerun and adds new registered agents without rotating older pairs. It performs no networking, live deployment, provider login copy or model call:

```sh
bun run build
node examples/mesh/provision.mjs examples/mesh/directory.example.json /private/existing-parent/peers /auth/a2a
```

The endpoint directory contains only registered URLs and transport trust options. Copy each generated agent's private directory to that agent's designated credential location during a separately authorized deployment, set `PI_A2A_CONFIG=/auth/a2a/agents.json`, and grant only the required private HTTPS connectivity. Do not mount every agent's credentials into every owner or weaken TLS/origin checks.

`validateInput` allows a synchronous, isolated model-input guard after document extraction but before admission. `push.validatePayload` guards actual callback JSON, including a pending body recovered after restart. These callbacks can withhold but cannot rewrite immutable input or callback bytes.

## Inline photos and durable push

These server features are opt-in; existing text-only applications retain their behavior.

- Set `images: true`, advertise `image/jpeg` and `image/png`, and explicitly mount the HTTP handler with `maxBodyBytes: A2A_IMAGE_MAX_BODY_BYTES` (6 MiB). The handler's default stays 64 KiB. Inline A2A 1.0 parts use `{raw: BASE64, mediaType: "image/jpeg"}`. There are at most four decoded 1 MiB images; caption text keeps the 8192-byte limit. URLs and arbitrary data are rejected. The existing Harness receives actual Pi image content; task history contains bounded attachment placeholders, not another copy of image bytes. New receipts bind canonical content and original associations, including image-removal conflicts; older text receipts remain compatible.
- Set `push: {allowedOrigins: ["https://push.example.com"]}` and advertise `capabilities.pushNotifications: true`. After the owner starts listening, call `adapter.startPush()`; await `adapter.close()` before closing its Harness. Callback URLs must use an exact approved HTTPS origin, without user information, query or fragment. HTTP loopback is an explicit development/test exception. Redirects are never followed. Callback bearer credentials stay in private adapter metadata, not model entries or task output.
- Standard configuration CRUD and `SendMessage.configuration.taskPushNotificationConfig` are implemented. Admission saves its initial configuration in the same commit. The pump observes committed actionable states even without an HTTP/SSE task observer. Delivery intent is stored before POST; retry keeps the exact body, exponential backoff and acknowledgement across SQLite reopen. The body is the official SDK's A2A 1.0 `StreamResponse` JSON, MIME `application/a2a+json`.
- Delivery is at least once, not proof of a notification appearing or being read. A receiver must authenticate, validate task/context identity, deduplicate committed revisions and keep notification content private. `INPUT_REQUIRED` and `AUTH_REQUIRED` must come from explicit application classification, never guesses from model prose. Ordinary questions can also arrive in completed answer text.

## Inline documents

Set `documents: true`, advertise `application/pdf`, `text/plain`, `text/markdown` and `text/csv`, and explicitly mount the handler with `maxBodyBytes: A2A_DOCUMENT_MAX_BODY_BYTES` (12 MiB). The default handler limit remains 64 KiB, and document inputs stay disabled unless opted in. Standard A2A parts use `{raw: BASE64, mediaType: "application/pdf", filename: "document.pdf"}`; attachment URLs are never fetched.

A message may contain one document alongside its caption and existing photo allowance. PDFs are limited to 4 MiB, 32 pages and 128 KiB of extracted UTF-8 text; TXT/Markdown/CSV files are nonempty UTF-8 and at most 128 KiB. Extraction runs locally through pinned PDF.js/unpdf in short-lived workers, at most two concurrently, with a 15-second deadline and V8 heap limits. No provider upload, embedded script execution, OCR, visual/layout interpretation or automatic truncation is performed. Locked, malformed, oversized and scanned/blank-page PDFs are rejected before model admission.

The existing Harness receives page-labeled extracted text as untrusted reference material, not a fabricated file path or the PDF's base64. Task history contains only a bounded attachment description. Original bytes, MIME type, filename and conversation/task associations are bound to the immutable receipt; an identical retry deduplicates across reopen before parsing again. Text/photo-only receipt fingerprints stay backward-compatible.

Document decoding failures use standard `CONTENT_TYPE_NOT_SUPPORTED` ErrorInfo with `metadata: {input: "document", admission: "rejected"}`. Clients may restore a **fresh** attempt's draft after that explicit rejection. A later failed retry does not prove whether an earlier uncertain attempt was admitted; never automatically resend or replace its identity.

## Host-owned file artifacts

An application can opt into `fileArtifacts: async task => artifacts` and advertise its supported output MIME types alongside `text/plain`. The callback receives an isolated copy of an authenticated, committed completed task, including on reads of older retained tasks. It must be read-only: no new model request, generation, upload or approval. The original text answer, status timestamp and persisted task remain unchanged.

Return at most four additional artifacts with unique IDs and URL parts using advertised media types. Metadata is bounded to 64 KiB; URLs must be credential-free, without query/fragment, on an advertised agent origin. The adapter never reads a file or fetches a URL. The application must authenticate its file route, bind the exact file to its owning task, reject traversal/symlinks, bound bytes and verify integrity. Clients must pin the origin before attaching credentials and make public/gallery export an explicit user action. This is not provider-URL forwarding or automatic device delivery.

## Install as a Pi extension

```sh
pi install npm:@leocavalcante/pi-a2a
```

Then run `/reload` in Pi, or start a new session. Pi loads the TypeScript extension directly and supplies its own coding-agent and TypeBox packages. To try the extension once without adding it to your settings, run `pi -e npm:@leocavalcante/pi-a2a`.

To follow unreleased changes, install from GitHub instead:

```sh
pi install git:github.com/leocavalcante/pi-a2a
```

Git installations track `main` and report version `0.0.0-development`, so Pi doesn't show release notes for them. Remove either installation with `pi remove` and the same source.

Create a **machine-local** `~/.pi/a2a/agents.json`:

```json
{
  "agents": {
    "demo": {
      "url": "http://127.0.0.1:7777",
      "allowHttpLoopback": true
    },
    "remote": {
      "url": "https://agent.example.com",
      "bearerTokenEnv": "REMOTE_A2A_TOKEN"
    }
  }
}
```

The `.pi` directory comes from Pi's `CONFIG_DIR_NAME`. `PI_A2A_CONFIG` selects another configuration file. There is no hostname detection, ambient cluster, network scan or automatic cross-host fallback. Unknown agents fail closed. The file permits endpoint URLs and credential **references**, not literal tokens or arbitrary shell commands. Use `bearerTokenEnv` or an absolute `bearerTokenFile` path, never both. File-backed credentials are read only for requests, not exported to the whole Pi process. Keep credential files private (mode 600) and outside Git. Do not put the file or credentials in public dotfiles.

The tools are:

- `a2a_agents`: list configured names without contacting them.
- `a2a_send`: send authorized text; retain its `messageId`, `taskId` and `contextId`. Interactive Pi returns admission promptly and watches for the reply in the invoking history by default; `wait: true` waits inline.
- `a2a_get_task`: read a retained task, optionally waiting without submitting work.
- `a2a_cancel_task`: explicitly request cancellation, which may be refused.

A successful tool RPC (`ok: true`) does **not** imply a successful task. Inspect `state`, especially `FAILED`, `CANCELED`, `INPUT_REQUIRED` and `AUTH_REQUIRED`. Text output is bounded to 32 KiB, including its JSON escaping, with a `truncated` flag; non-text artifacts are not downloaded. Remote error text is not forwarded because it can contain credentials or provider diagnostics.

Manual commands do not invoke a Pi-session model, including when an asynchronous reply arrives:

```text
/a2a list
/a2a send demo Hello
/a2a result demo TASK_ID
/a2a cancel demo TASK_ID
```

A2A receipts and completion replies use Pi's default custom-message renderer and active global theme. The extension does not override their colors.

The remote agent may invoke its own model when receiving a message. A normal follow-up uses the returned `contextId` and a **new messageId**. A task awaiting input/auth can receive a new message with its `taskId`. A completed task cannot be reopened: start a new task in its context.

### Automatic replies in interactive Pi

| Entry point | Default behavior |
| --- | --- |
| TUI `a2a_send` | Return admission with `watching: true` for an active task; deliver its eventual response in this history and start one assistant follow-up. |
| TUI `/a2a send` | Return admission promptly; display the eventual remote response and an in-Pi notification, with **zero local model calls**. |
| Explicit `a2a_send(wait: true)` | Wait in the tool and return the result inline, without an automatic duplicate. |
| Print, JSON and RPC | Keep foreground waiting by default. Explicit `wait: false` returns a receipt with `watching: false`, not a background-delivery promise. |

A direct Message or an already settled Task returns inline without another completion notification. `watching` means a local observer was registered, not that the remote task succeeded or that delivery is guaranteed while Pi is closed. You do not need to keep asking Pi to check a watched task. Explicit task reads remain available and do not enroll arbitrary historical tasks.

The observer uses official SDK `GetTask` and `SubscribeToTask`, independently of the finished send tool. Intermediate task/status events update the progress display; the delivered completion state/artifacts still come from an authoritative task read, not partial streamed text. Replies are bounded, explicitly framed as remote data, and state when no text result was supplied. Non-text artifacts are never downloaded. Input/auth-required results ask for human action, not automatic approval; a later authorized message with a new message ID can watch the same task again.

If Pi is busy, ready replies stay outside its message queue until it is idle. Delivery is restricted to the originating active session/history. Tool-origin replies trigger an assistant follow-up; command-origin replies only display the response and a notification. No local model runs for observation, reconnection or bookkeeping. Remote content is data, not a user request or authorization.

### Live progress

Interactive background sends, from either `/a2a send` or `a2a_send`, show a themed, animated widget near the editor:

```text
A2A
⠋ demo [a1b2c3d4] · Generating response (turn 1, attempt 1)
  watching 23s · last event 18s ago
```

The Durable adapter derives status messages from the submission's own committed live state: queued, working, generating a response, retry backoff, deferred model response, blocking compaction, or completed tool counts. It does not publish reasoning, model partials, tool names/arguments/output, or retry diagnostics. Unchanged stages do not create synthetic progress events. These are standard A2A status messages, also available to other A2A clients through task reads and streaming.

The widget keeps separate rows for concurrent tasks (up to five visible, with an overflow count), shows reconnecting or observation-paused states, and retains a ready indicator if Pi is busy before delivery. It clears after delivery or session navigation/shutdown. Widget updates use bounded, single-line, terminal-control-safe status text; these updates are never injected into model context or saved as progress history. No local model calls or additional polling are used for the display. Foreground waits and non-TUI modes retain their existing behavior.

`watching` measures time since this local observation began, resetting when a history reopens. `last event` measures receipt of a remote task/status/artifact event or task-read status, not proven forward progress. The animation indicates local observation, not remote health; silence alone does not mark the remote task failed. No completion percentage is invented. Existing agents need an updated adapter in their owning application to report the richer stages; a client-only update can still display their coarse task state. Deployment cutovers remain application-owned.

### Recovery and limitations

Receipts are appended to the active Pi history before networking and after admission. Versioned `pi-a2a.watch` entries retain only observation identities/policy and bounded ready results. Their phases are `intent`, `admitted`, `ready`, `paused`, and `inline` (no automatic duplicate). They do not retain credentials, full Task objects or another copy of the outgoing prompt. A matching persisted `pi-a2a.completion` message acknowledges delivery; merely calling `sendMessage()` does not.

Saved histories recover undelivered observations when reopened. An intent without a known admission stays uncertain and is **never automatically resubmitted**. Old receipts, shell/CLI sends and arbitrary historical tasks are not imported as watches. Implementing this feature does not change workflows that still submit through the separate official `a2a` CLI.

**Pi must be running with the invoking history active for live delivery.** Closing Pi or selecting another session/history pauses local observation, not remote work. Forks do not inherit ownership of their parent's watches. Deduplication is branch-local: a descendant history containing admission can recover its result; an alternate history without the earlier completion may receive its own copy. Compaction does not remove raw recovery records. There is no cross-process exactly-once guarantee or proof that a user read a response.

**Fresh command-only histories:** live `/a2a` replies work, but Pi 1.5.0 does not create a session file until an ordinary user/assistant message exists. Closing an otherwise unsaved history loses its in-memory receipts and recovery state. The extension does not reject fresh-session sends, invent a user message, invoke a local model, or write session files directly to bypass this limitation.

Unsupported streaming, missing credentials, changed/removed targets or exhausted transient recovery pause the observer with one sanitized, actionable in-Pi notice. The admitted task may still be running. Inspect its retained ID through existing reads, or reopen the eligible history to retry observation. There is no new polling fallback, remote cancellation or host/transport fallback. Unproductive reconnects stop after five cycles with 1, 2, 4 and 8 second backoff; healthy long streams can renew without imposing a task deadline.

The extension does not automatically copy the session transcript to a remote agent. Endpoint changes invalidate saved context associations and prevent old watches from delivering under a retargeted alias. Authentication, origin restrictions, redirect rejection and response bounds apply to subscriptions/reconnections too. Agent responses and cards are not authority to change the session's instructions.

## Use the client without Pi

Install from this repository and build it with `bun run build`. Import from `pi-a2a/client`:

```ts
import { connectAgent, isTask, newMessageId, sendText, waitForTask } from "@leocavalcante/pi-a2a/client";

const client = await connectAgent("https://agent.example.com", {
  headers: () => ({ Authorization: `Bearer ${process.env.REMOTE_A2A_TOKEN}` }),
});
const messageId = newMessageId(); // Retain this BEFORE sending.
const response = await sendText(client, "An explicitly authorized request", { messageId });
const result = isTask(response) ? await waitForTask(client, response.id) : response;
```

`connectAgent` returns the native official-SDK `Client`, so its structured messages, task methods and streams remain available. Credentials come from a host callback; no credential store or provider login is copied. Agent Cards cannot redirect authenticated requests to a new origin: configure `allowedOrigins` explicitly when a legitimate card advertises additional endpoints. HTTP redirects are rejected. HTTPS is the default; plaintext loopback is an explicit local/development exception. Complete JSON responses are capped at 2 MiB; the SDK bounds individual streaming events.

## Attach to an existing Durable agent

The application must already own its Harness and single-writer lock. Do **not** open its database again in an A2A sidecar or second process.

```ts
import { AgentCard } from "@a2a-js/sdk";
import { createDurableA2A } from "@leocavalcante/pi-a2a/durable";
import { a2aHttpHandler, bearerAuth } from "@leocavalcante/pi-a2a/server";

const card = AgentCard.fromJSON({
  name: "My agent",
  description: "Application-owned capabilities",
  version: "1.0.0",
  supportedInterfaces: [{
    url: "https://agent.example.com/a2a",
    protocolBinding: "JSONRPC", protocolVersion: "1.0"
  }],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
  securitySchemes: {
    bearer: { httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "opaque" } }
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  skills: [{ id: "assist", name: "Assist", description: "Handle authorized requests", tags: ["assistant"] }]
});
const adapter = createDurableA2A({
  harness,
  card,
  conversation: identity => conversationsFor(identity.userId, identity.tenant)
});
const a2a = a2aHttpHandler(adapter, {
  authenticate: bearerAuth(() => process.env.A2A_SERVER_TOKEN, "owner")
});
// Mount in the EXISTING owner's HTTP(S) server:
// if (await a2a(request, response)) return;
```

The snippet assumes your existing `harness` and `conversationsFor` function. For a single-owner personal agent, a resolver can return its existing root. The resolver also receives `{reason, messageId}`: `send` when a message starts a new context, `adopt` when `existingSubmission` checks an old message ID. Messages in a known context reuse its bound conversation without calling it. To give each new piece of work its own model context, return a fresh `harness.createConversation(...)` for `send` and the conversation that owns legacy inputs (for example, the root) for `adopt`. For unrelated users, **do not** return the same private conversation. Task/context reads and listings are scoped to authenticated identity and tenant, but sharing the underlying conversation would still share its model context. Real multi-user authentication/authorization is host-owned; the bearer helper is a single-identity building block, not an OAuth server.

Public Agent Cards should disclose only intended capabilities. Private profiles, system prompts, tokens, filesystem paths and internal deployment addresses do not belong in them. Use TLS in production, directly or at a trusted local TLS proxy. Without an authentication callback the handler denies access; `allowUnauthenticatedLoopback` is an explicit exception for trusted local adapters/demos. The convenience `createA2AServer` is HTTP and should listen on loopback; production applications can mount the handler in their existing HTTPS server. Public source does not require public agents or a central gateway. When sharing an HTTP listener, protect its other data/message routes too: A2A-specific authentication does not secure unrelated legacy endpoints.

### Existing submissions and the official CLI

Use the official [`a2a`](https://github.com/a2aproject/a2a-cli) CLI, tested with release **v0.3.1** (A2A protocol 1.0):

```sh
a2a --config /private/path/agent.json card get
a2a --config /private/path/agent.json send --request-payload request.json -o json
a2a --config /private/path/agent.json task get TASK_ID --wait -o json
```

Keep the endpoint and authentication in a private CLI config, not shell arguments or source. For retry-safe automation, retain a standard SendMessageRequest JSON file with an explicit `message.messageId` before sending it; retry that exact payload after an uncertain send. The CLI's JSON task result uses a `task` envelope. An interrupted local wait does not cancel remote work.

When replacing an older transport, the host may supply `existingSubmission(messageId, identity, conversation)` on `DurableA2AOptions`. Return the already admitted `submissionId` and the original UTF-8 text's lowercase `textSha256`, or `undefined`. The adapter checks that the input belongs to the resolved conversation, then persists its A2A binding without submitting it again. The old message ID becomes its task ID; both `GetTask(oldId)` and identical-message replay adopt it lazily. Conflicting text fails. Imported tasks join task listings after adoption, not via a scan of unrelated application data. Only the stored final answer is projected; unavailable original input text is not invented.

### Durable semantics

- Server-generated A2A task/context IDs are distinct from caller message IDs and JSON-RPC correlation IDs.
- Admission and the message-ID/task binding are in **one Durable commit**. Identical IDs/text deduplicate after restart; changing text or its task/context association conflicts.
- The adapter uses its own `pi-a2a.*` document kinds. It does not reset conversations, change models, own provider credentials or migrate application-specific legacy receipt formats automatically.
- The host reinstalls its definitions and calls `harness.resume()` after reopening. Pending execution remains the host's responsibility.
- Result reads reconcile the persisted submission with the retained A2A task. Status/artifact snapshots survive restart; reconnect obtains the current task, not a replay of every historical stream event.
- An application can supply `classifyAnswer` to mark a committed answer as `INPUT_REQUIRED`, `AUTH_REQUIRED` or `REJECTED`. The adapter never guesses human approval from prose and never fulfills an auth challenge automatically.
- Local stream/wait cancellation only stops that observer. **CancelTask currently withdraws queued submissions only.** A running submission returns `TaskNotCancelable`: Pi 1.5 cannot abort it independently once placed, and aborting a shared conversation could cancel unrelated work. Cancellation does not undo partial external effects.
- Histories returned to clients are bounded to the newest 50 messages. `historyLength: 0` omits history. Task listing is cursor-paginated and authorization-scoped; the initial implementation keeps a per-owner Durable index and is not a large-scale indexing benchmark.
- This is process-crash persistence, not a power-loss, backup, HA or exactly-once inference guarantee. Interrupted model requests may be retried by Durable; external actions still need their own idempotency/reconciliation.

To give a Durable agent outbound A2A tools:

```ts
import { createA2ATools } from "@leocavalcante/pi-a2a/durable";
registry.install(createA2ATools()); // reads the same explicit machine-local config
```

Outbound tools use replay-safe execution with native memos: a confirmed task resumes observation, while an unacknowledged attempted send is never automatically repeated. This does not assume arbitrary peers deduplicate message IDs or make their external effects exactly once. Inspect retained identities after uncertain outcomes. Remote model usage is not standardized by A2A and is not fabricated as zero or added twice to the caller's usage.

## Model-free runnable example

```sh
bun install --frozen-lockfile
bun run example
```

This serves a scripted local agent at `http://127.0.0.1:7777`, using SQLite under `./data/`. It makes **no provider requests**. Try `/a2a send demo Hello` from Pi with the configuration above. `DEMO_DATA_DIR` and `PORT` change its private directory and loopback port. An exclusive owner lock fails closed with exit 73; after a hard crash, verify the old process is gone before removing its stale `demo.owner`. SIGTERM closes the owner without durably canceling admitted work.

A real application supplies its own models, prompts, tools, credentials, environment and approval policy. Neither a working directory nor A2A is a sandbox.

## npm publication

Merging a releasable Conventional Commit to `main` publishes `@leocavalcante/pi-a2a` automatically, with npm provenance, and creates a GitHub release. The version on `main` is `0.0.0-development`; release versions live in tags and on npm. See [CONTRIBUTING.md](CONTRIBUTING.md) for release setup and recovery.

## Development and verification

```sh
bun install --frozen-lockfile
bun run verify
git diff --check
```

`verify` type-checks the source, tests, and examples; runs the Bun test suite and the Node.js lane (the extension load test, SIGKILL recovery, and the Durable tests that use Node's built-in SQLite); builds the package and installs it into an isolated consumer; and audits dependencies. Development uses Bun 1.4.4 and TypeScript 6.0.3. Pi and SDK users run the package on Node.js.

Tests use synthetic messages, isolated stores and faux providers. They exercise the official client against Durable, a non-Pi official-SDK peer, real TUI-bound SDK sessions with delayed HTTP/SSE replies, model-free command completion, busy-session ordering, disk-backed client reopen and lost-injection recovery, branch-local deduplication, bounded reconnects, request conflicts, SQLite reopen/recovery, interrupted waiting, scoped cancellation, task pagination and ownership, protocol errors, output limits and credential-origin boundaries. Passing these tests is not official A2A certification or evidence of live OAuth, every third-party deployment, paid model quality or production HA.

The library and examples contain no machine-local agent configuration, credential exports, private harness content or domain profiles. Deployment cutovers belong to their owning applications, not this public repository.
