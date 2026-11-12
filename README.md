# pi-a2a

Talk to A2A agents from Pi, and serve Pi Durable agents over the A2A protocol.

[![npm](https://img.shields.io/npm/v/@leocavalcante/pi-a2a)](https://www.npmjs.com/package/@leocavalcante/pi-a2a) [![CD](https://github.com/leocavalcante/pi-a2a/actions/workflows/cd.yaml/badge.svg)](https://github.com/leocavalcante/pi-a2a/actions/workflows/cd.yaml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/leocavalcante/pi-a2a/blob/main/LICENSE)

Delegate an authorized request to a configured agent from Pi and inspect its task ID, state, and text. Or expose an existing Pi Durable Harness through A2A 1.0 without opening a second database owner. The Pi extension sends only the request text you choose; it never copies your session transcript automatically.

## Contents

- [Installation](#installation)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Compatibility](#compatibility)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Installation

```sh
pi install npm:@leocavalcante/pi-a2a
```

Then run `/reload` in Pi, or start a new session. To try pi-a2a once without adding it to your settings, run `pi -e npm:@leocavalcante/pi-a2a`.

The unrelated, unscoped npm package `pi-a2a` is not this project. Use the scoped package shown above.

To follow unreleased changes, install from GitHub instead:

```sh
pi install git:github.com/leocavalcante/pi-a2a
```

Git installations track `main` and report version `0.0.0-development`, so Pi does not show release notes for them. Remove either installation with `pi remove` and the same source.

## Usage

### Pi tools and command

| Tool or command   | Parameters                                                                   | What it does                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `a2a_agents`      | None                                                                         | Lists configured agent names without contacting them or sending session context.                                                       |
| `a2a_send`        | `agent`, `message`; optional `messageId`, `contextId`, `taskId`, `wait`      | Sends authorized text. In interactive Pi, it returns admission promptly and watches for an active task by default.                     |
| `a2a_get_task`    | `agent`, `taskId`; optional `wait`                                           | Reads an existing task without submitting work. `wait: true` observes it until a terminal state or an input or authentication request. |
| `a2a_cancel_task` | `agent`, `taskId`                                                            | Requests remote cancellation. The agent can reject it, and cancellation can leave partial external effects.                            |
| `/a2a`            | `list`; `send AGENT MESSAGE`; `result AGENT TASK_ID`; `cancel AGENT TASK_ID` | Lists configured names, sends a message, reads a task, or requests cancellation without invoking Pi's model.                           |

Keep the `messageId` returned by `a2a_send`. Use the returned `contextId` and a new message ID for a follow-up. A task awaiting input or authentication can receive a new message with its `taskId`. A completed task cannot be reopened; start another task in its context.

A successful tool call does not mean the remote task succeeded. Check its `state`, especially `FAILED`, `CANCELED`, `INPUT_REQUIRED`, and `AUTH_REQUIRED`. Text output is limited to 32 KiB, including JSON escaping, and sets `truncated` when needed. pi-a2a does not download non-text artifacts. It does not forward remote error text that could contain credentials or provider diagnostics.

You can also use these manual commands. They do not call a Pi-session model, including when an asynchronous reply arrives:

```text
/a2a list
/a2a send demo Hello
/a2a result demo TASK_ID
/a2a cancel demo TASK_ID
```

### Automatic replies in interactive Pi

| Entry point            | Default behavior                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI `a2a_send`         | Returns admission with `watching: true` for an active task; delivers its eventual response in this history and starts one assistant follow-up. |
| TUI `/a2a send`        | Returns admission promptly; displays the eventual response and a Pi notification, with no local model calls.                                   |
| `a2a_send(wait: true)` | Waits in the tool and returns the result inline, without an automatic duplicate.                                                               |
| Print, JSON, and RPC   | Waits in the foreground by default. `wait: false` returns a receipt with `watching: false`, not a background-delivery promise.                 |

A direct Message or an already settled Task returns inline without another completion notification. `watching` means pi-a2a registered a local observer; it does not mean the remote task succeeded or that Pi can deliver while closed. You do not need to keep asking Pi to check a watched task. Explicit task reads remain available and do not enroll arbitrary old tasks.

The observer uses A2A `GetTask` and `SubscribeToTask`, independently of the finished send tool. Progress events update the display; an authoritative task read supplies the final state and artifacts. pi-a2a does not return partial streamed text as the final result. `INPUT_REQUIRED` and `AUTH_REQUIRED` need human action, not automatic approval. A later authorized message with a new message ID can watch the same task again. If Pi is busy, a ready reply stays out of its message queue until Pi is idle. Delivery stays in the originating active session and history. Tool-origin replies start one assistant follow-up; command-origin replies only display the response and a notification. Observation, reconnection, and bookkeeping make no local model calls.

### Live progress

Interactive background sends show an animated widget near the editor. It keeps separate rows for concurrent tasks and shows up to five before an overflow count. Each row shows the agent, a short task ID, elapsed time, and last received event. Progress comes from fixed task states such as queued, working, generating a response, waiting for a deferred model response, compacting, retrying, or completing tool counts. Unchanged stages do not create synthetic progress events. The widget shows reconnecting, paused, and ready states, and clears after delivery or session navigation or shutdown. It does not show reasoning, model partials, tool names, arguments, output, or retry diagnostics.

The widget is local display only. Its updates are bounded, single-line, terminal-control-safe text; they never enter model context or saved progress history. The display does not poll for progress, add model calls, write progress into history, or invent a completion percentage. Its animation means Pi is observing, not that the remote agent is healthy. `watching` measures local observation time and resets when a history reopens. `last event` means a remote task, status, or artifact event or task read arrived; it does not prove forward progress. Existing agents need an updated Durable adapter to report richer stages; older agents still show their coarse task state. Receipts and completion replies use Pi's default custom-message renderer and active global theme; pi-a2a does not override their colors.

### Recover Pi observations

The extension appends a receipt to the active Pi history before networking and after admission. Versioned `pi-a2a.watch` entries retain observation identity, policy, and bounded ready results. They do not store credentials, full Task objects, or another copy of the outgoing prompt. Watch phases are `intent`, `admitted`, `ready`, `paused`, and `inline`. A matching persisted `pi-a2a.completion` message acknowledges delivery; calling `sendMessage()` alone does not.

Saved histories recover undelivered observations when reopened. An intent without a known admission stays uncertain and is never automatically resubmitted. Old receipts, shell or CLI sends, and arbitrary historical tasks are not imported as watches. This feature does not change workflows that submit through the separate official `a2a` CLI.

Pi must be running with the invoking history active for live delivery. Closing Pi or selecting another session pauses local observation, not remote work. Forks do not inherit their parent's watches. Deduplication is branch-local: a descendant history containing admission can recover its result, while an alternate history without the earlier completion may receive its own copy. Compaction does not remove raw recovery records. There is no cross-process exactly-once guarantee or proof that you read a response.

Pi 1.5.0 does not create a session file until an ordinary user or assistant message exists. Closing an otherwise unsaved command-only history loses its in-memory receipts and recovery state. pi-a2a does not reject fresh-session sends, invent a user message, invoke a local model, or write session files directly to bypass this limitation.

Unsupported streaming, missing credentials, changed or removed targets, or exhausted transient recovery pause the observer with one sanitized, actionable Pi notice. The admitted task may still be running. Inspect its retained ID or reopen the eligible history to retry observation. There is no polling fallback, remote cancellation, or host/transport fallback. Unproductive reconnects stop after five cycles with 1, 2, 4, and 8 second backoff; healthy long streams can renew without a task deadline.

The extension does not copy the session transcript to a remote agent. Endpoint changes invalidate saved context associations and prevent old watches from delivering under a retargeted alias. Authentication, origin restrictions, redirect rejection, and response bounds also apply to subscriptions and reconnections. Agent responses and cards cannot change the session's instructions.

### Use the client without Pi

Install the package in your Node.js application with `npm install @leocavalcante/pi-a2a`. From a source checkout, run `bun run build` before importing the SDK. The client uses the official A2A SDK and does not import Pi:

```ts
import {
  connectAgent,
  isTask,
  newMessageId,
  sendText,
  waitForTask,
} from "@leocavalcante/pi-a2a/client";

const client = await connectAgent("https://agent.example.com", {
  headers: () => ({
    Authorization: `Bearer ${process.env.REMOTE_A2A_TOKEN}`,
  }),
});
const messageId = newMessageId(); // Retain this before sending.
const response = await sendText(client, "An explicitly authorized request", {
  messageId,
});
const result = isTask(response)
  ? await waitForTask(client, response.id)
  : response;
```

`connectAgent` returns the native official-SDK `Client`, including its structured messages, task methods, and streams. Supply credentials through a host callback; pi-a2a copies no provider login or credential store. Agent Cards cannot authorize new origins: configure `allowedOrigins` for any additional endpoint you trust. Redirects are rejected. HTTPS is the default; allow HTTP only for explicitly enabled loopback development. Complete JSON responses are capped at 2 MiB, streaming events use the SDK's per-event bound, and the client timeout defaults to 330 seconds.

Retain the message ID before sending. If a send is uncertain, inspect the original message or task ID before taking action; do not retry with a new ID.

## How it works

### Serve an existing Pi Durable agent

Attach the adapter to the application that already owns the Harness and its single-writer lock. Do not open the same database from an A2A sidecar or second process. The adapter accepts `text/plain` messages up to 8192 UTF-8 bytes by default.

```ts
import { AgentCard } from "@a2a-js/sdk";
import { createDurableA2A } from "@leocavalcante/pi-a2a/durable";
import { a2aHttpHandler, bearerAuth } from "@leocavalcante/pi-a2a/server";

const card = AgentCard.fromJSON({
  name: "My agent",
  description: "Application-owned capabilities",
  version: "1.0.0",
  supportedInterfaces: [
    {
      url: "https://agent.example.com/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
  capabilities: { streaming: true },
  securitySchemes: {
    bearer: {
      httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "opaque" },
    },
  },
  securityRequirements: [{ schemes: { bearer: { list: [] } } }],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "assist",
      name: "Assist",
      description: "Handle authorized requests",
      tags: ["assistant"],
    },
  ],
});
const adapter = createDurableA2A({
  harness,
  card,
  conversation: (identity) =>
    conversationsFor(identity.userId, identity.tenant),
});
const a2a = a2aHttpHandler(adapter, {
  authenticate: bearerAuth(() => process.env.A2A_SERVER_TOKEN, "owner"),
});
// Mount in the existing owner's HTTP(S) server:
// if (await a2a(request, response)) return;
```

The snippet assumes your application already defines `harness` and `conversationsFor`. Resolve each authenticated identity to its own conversation. Do not return one private conversation for unrelated users; A2A task scoping does not isolate shared model context. Authentication and multi-user authorization belong to the host application. The bearer helper is a single-identity building block, not an OAuth server.

The handler uses the official SDK for A2A 1.0 JSON-RPC over HTTP at `/a2a` and serves Agent Card discovery at `/.well-known/agent-card.json`. It requires authentication by default. Remote traffic must use TLS, directly or through a trusted local TLS proxy. `allowUnauthenticatedLoopback` is an explicit exception for local demos. The HTTP convenience `createA2AServer` should listen on loopback; mount the handler in your existing HTTPS server for production. If you share an HTTP listener, protect its non-A2A routes separately.

Without an authentication callback or the explicit loopback exception, the handler denies access. Public Agent Cards should list only intended capabilities; do not put private profiles, prompts, tokens, filesystem paths, or internal addresses in them. Public source does not require public agents or a central gateway.

### Durable tasks and recovery

The adapter maps A2A requests to your existing Harness and persists its own `pi-a2a.*` document kinds in that Harness. It does not reset conversations, change models, own provider credentials, or automatically migrate application-specific receipt formats. The host reinstalls its definitions and calls `harness.resume()` after reopening; pending execution remains the host's responsibility.

- Server-generated A2A task and context IDs differ from caller message IDs and JSON-RPC correlation IDs.
- Admission and the message-ID/task binding share one Durable commit. Reusing the same message ID and input deduplicates after restart; changed input or task/context association conflicts.
- Reads reconcile the stored submission with its retained task. Status and artifact snapshots survive restart, but a reconnect returns the current task, not every historical stream event.
- The host can classify a committed answer as `INPUT_REQUIRED`, `AUTH_REQUIRED`, or `REJECTED`. pi-a2a never guesses approval from model prose or fulfills an authentication challenge. A successful task or tool phase does not prove that an external effect succeeded.
- Canceling a local wait or stream stops only that observer. `CancelTask` withdraws queued submissions only. Pi 1.5 cannot independently abort a running submission, and aborting a shared conversation could cancel unrelated work. Cancellation also cannot undo partial external effects.
- Task history returns the newest 50 messages; `historyLength: 0` omits history. Task listing uses cursor pagination and authorization-scoped per-owner indexes; it is not a large-scale indexing benchmark.

This provides process-crash persistence, not power-loss, backup, high-availability, or exactly-once inference guarantees. Durable may retry an interrupted model request. External actions still need their own idempotency and reconciliation.

To adopt an input admitted by an older transport, pass `existingSubmission(messageId, identity, conversation)`. Return its existing `submissionId` and the original text's lowercase SHA-256 digest. The adapter verifies that the submission belongs to the resolved conversation, then binds it without resubmitting. The old message ID becomes its task ID; `GetTask(oldId)` and an identical-message replay adopt it lazily. Imported tasks enter listings after adoption. The adapter does not invent unavailable original input text.

You can use the official [`a2a` CLI](https://github.com/a2aproject/a2a-cli), tested with release `v0.3.1` and A2A 1.0:

```sh
a2a --config /private/path/agent.json card get
a2a --config /private/path/agent.json send --request-payload request.json -o json
a2a --config /private/path/agent.json task get TASK_ID --wait -o json
```

Keep the endpoint and authentication in a private CLI config, not shell arguments or source. For retry-safe automation, save a standard `SendMessageRequest` JSON file with an explicit `message.messageId` before sending; retry the exact payload after an uncertain send. The CLI's JSON task result uses a `task` envelope. Interrupting a local wait does not cancel remote work.

### Inline photos

Photo input is opt-in. Set `images: true`, advertise `image/jpeg` and `image/png`, and mount the handler with `maxBodyBytes: A2A_IMAGE_MAX_BODY_BYTES` (6 MiB). The handler's default remains 64 KiB. Use inline A2A parts such as `{ raw: BASE64, mediaType: "image/jpeg" }`.

A message can contain up to four decoded images, each at most 1 MiB, with a 4 MiB combined image limit. The caption keeps the 8192-byte text limit. Attachment URLs and arbitrary data are rejected. The Harness receives real Pi image content; task history stores bounded attachment placeholders, not another copy of the image bytes. Receipts bind canonical content and original associations, including image-removal conflicts. Identical retries deduplicate across reopen, and existing text-only receipts remain compatible.

### Inline documents

Document input is opt-in. Set `documents: true`, advertise `application/pdf`, `text/plain`, `text/markdown`, and `text/csv`, and mount the handler with `maxBodyBytes: A2A_DOCUMENT_MAX_BODY_BYTES` (12 MiB). The handler's default remains 64 KiB. A message can contain one document with its caption and the enabled photo allowance. pi-a2a never fetches attachment URLs.

- PDFs are limited to 4 MiB, 32 pages, and 128 KiB of extracted UTF-8 text.
- TXT, Markdown, and CSV files must be nonempty UTF-8 and at most 128 KiB.
- Extraction runs locally through pinned PDF.js via `unpdf` in short-lived workers. At most two documents decode at once; each PDF has a 15-second deadline and V8 heap limits.
- Extraction does not upload files to a provider, run embedded scripts, perform OCR, perform visual or layout interpretation, or truncate text. Locked, malformed, oversized, scanned, and blank-page PDFs are rejected before model admission.

The Harness receives page-labeled extracted text as untrusted reference material, not a fabricated file path or the PDF's base64. Task history stores a bounded attachment description. The immutable receipt binds original bytes, MIME type, filename, and conversation/task associations. An identical retry deduplicates across reopen before parsing again; text/photo receipt fingerprints remain backward-compatible.

Document decode failures return A2A `CONTENT_TYPE_NOT_SUPPORTED` with `metadata: { input: "document", admission: "rejected" }`. A client can restore a fresh attempt's draft after that explicit rejection. A later failed retry does not show whether an earlier uncertain attempt was admitted; do not automatically resend or replace its identity.

### Host-owned file artifacts

An application can opt into `fileArtifacts` and advertise its output MIME types alongside `text/plain`. The callback receives an isolated copy of an authenticated, committed completed task, including reads of retained tasks. It must be read-only: do not start another model request, generate or upload a file, or ask for approval. The original answer, status timestamp, and persisted task remain unchanged.

Return at most four additional artifacts with unique IDs and URL parts using advertised media types. Metadata is limited to 64 KiB, and each URL must be credential-free, without a query or fragment, and on an advertised agent origin. The adapter never reads a file or fetches a URL. Your application must authenticate its file route, bind the exact file to its task, reject traversal and symlinks, bound bytes, and verify integrity. Clients must pin the origin before attaching credentials and make public or gallery export an explicit user action. This is not provider-URL forwarding or automatic device delivery.

### Durable push notifications

Push is opt-in. Set `push: { allowedOrigins: ["https://push.example.com"] }`, advertise `capabilities.pushNotifications: true`, and start the pump after the owner starts listening with `adapter.startPush()`. Await `adapter.close()` before closing the Harness.

Callback URLs must use an exact approved HTTPS origin, without user information, query, or fragment. HTTP loopback is an explicit development exception. Redirects are never followed. Callback bearer credentials stay in private adapter metadata, not model entries or task output. Standard configuration CRUD and `SendMessage.configuration.taskPushNotificationConfig` are supported; admission saves its initial configuration in the same commit.

The pump observes committed actionable states even when no HTTP or SSE task observer is connected. It persists delivery intent before POST and retries the exact body with exponential backoff and its acknowledgement across SQLite reopen. The body is the official A2A 1.0 `StreamResponse` JSON with MIME type `application/a2a+json`. `push.validatePayload` can reject actual callback JSON, including a pending body recovered after restart.

Delivery is at least once. It does not prove a notification appeared or was read. Receivers must authenticate, validate task and context identity, deduplicate committed revisions, and keep notification content private. The application must explicitly classify `INPUT_REQUIRED` and `AUTH_REQUIRED`; pi-a2a never guesses these states from model prose. An ordinary question can also appear in completed answer text.

### Private discovery and delegation

Pi Durable owners can discover and contact any registered A2A peer without fixed pairings, a coordinator Harness, or a custom client. An ordinary A2A client submits to one agent; that agent can choose collaborators through tools and return its normal A2A task and result. LabAgents is not required.

Install `createA2ATools({ self: "alpha", guard: guardPublication })` in the existing registry. The tools are:

- `a2a_agents` reads live Agent Cards for registered endpoints, including roles, skills, media, and streaming capabilities. It supports `offset` and `limit` pagination.
- `a2a_send` delegates text and optionally waits for the result.
- `a2a_get_task` reads or observes existing work without submitting another message.

Discovery reads the explicit machine-local `AgentConfig`; it does not scan the network. The directory is re-read for each operation, so registering an endpoint needs no workflow or prompt change. An explicitly selected missing configuration is an error, not an empty directory. Cards and replies are remote data, not instructions or approval.

For a trusted mesh with one human owner, use `peerBearerAuth(readOwnerToken, "alpha-owner")`. Set `mesh: { name: "alpha", owner: { userId: "alpha-owner", tenant: "" } }` in the adapter options. The host conversation resolver must accept only its owner and authenticated `peerName(identity.userId)` identities, returning the existing root. The helper authenticates each peer with its own `incomingBearerTokenFile`; outbound requests use `bearerTokenFile` or `bearerTokenEnv`. It never distributes the human owner's token or provider credentials. Protect non-A2A status and admin routes separately; a valid peer is not their owner.

Authenticated peer provenance appears in model input and task metadata under `pi-a2a.peer`. Peers can read only their own tasks and cannot adopt owner legacy receipts. The configured human owner can read or list peer results, including task-bound file artifacts, but cannot replay or cancel across identities. This is a trusted, single-human-owner mesh, not isolation between unrelated users sharing one conversation.

Peer admission requires an idle existing conversation, checked in the admission commit. A busy recipient returns standard `UNSUPPORTED_OPERATION` ErrorInfo with `metadata: { input: "peer", admission: "rejected", busy: "true" }`; no peer input is queued. This prevents synchronous cross-agent wait cycles without aborting active work. Owner messages retain normal follow-up behavior or the host's explicit `whenBusy: "steer"` setting. A rejected peer request can be attempted later under the same identity; that differs from an uncertain send.

Durable outbound sends retain their target, attempt marker, acknowledgement, and bounded result in native task memos. Reopening after a confirmed acknowledgement resumes task observation rather than sending again. An attempted send without acknowledgement returns `DELIVERY_UNCERTAIN` and is never automatically resubmitted, even if a peer does not deduplicate. Endpoint changes stop pending observation under that alias. Advertised streaming uses task subscriptions and an authoritative final task read; a failed advertised stream does not fall back to polling. Non-streaming peers use ordinary `GetTask` observation. Local cancellation never calls remote `CancelTask`.

Outbound tool results keep bounded text and credential-free URL artifact references from approved origins; files are never downloaded. The producing agent retains artifact ownership and authentication. Host guards scan outgoing and incoming projections, and the shared tools withhold declared messaging credential values. They do not forward private profiles or transcripts, change domain permissions, or fabricate or double-count remote model usage.

The [mesh provisioning example](https://github.com/leocavalcante/pi-a2a/blob/main/examples/mesh/provision.mjs) and its [sample directory](https://github.com/leocavalcante/pi-a2a/blob/main/examples/mesh/directory.example.json) prepare separate, directional peer credentials and per-agent configuration outside Git. It preserves existing keys on rerun and adds registered agents without rotating old pairs. It performs no networking, live deployment, provider-login copy, or model call:

```sh
bun run build
node examples/mesh/provision.mjs examples/mesh/directory.example.json /private/existing-parent/peers /auth/a2a
```

The endpoint directory contains registered URLs and transport trust options only. Copy each generated private directory to that agent's designated credential location during a separately authorized deployment. Set `PI_A2A_CONFIG=/auth/a2a/agents.json` and grant only required private HTTPS connectivity. Do not mount every agent's credentials into every owner or weaken TLS/origin checks.

`validateInput` can run a synchronous, isolated model-input guard after document extraction but before admission. `push.validatePayload` guards callback JSON, including a pending body recovered after restart. These callbacks can withhold input, but they cannot rewrite immutable input or callback bytes.

### Model-free example

Run the [scripted echo example](https://github.com/leocavalcante/pi-a2a/blob/main/examples/echo.ts):

```sh
bun install --frozen-lockfile
bun run example
```

It serves a scripted local agent at `http://127.0.0.1:7777` and stores SQLite data under `./data/`. It makes no provider requests. Try `/a2a send demo Hello` from Pi with the configuration below. `DEMO_DATA_DIR` and `PORT` change its private directory and loopback port.

An exclusive owner lock fails closed with exit code 73. After a hard crash, verify the old process is gone before removing its stale `demo.owner`. SIGTERM closes the owner without durably canceling admitted work. A real application supplies its own models, prompts, tools, credentials, environment, and approval policy. Neither a working directory nor A2A is a sandbox.

## Configuration

The extension reads a machine-local JSON file at `~/.pi/a2a/agents.json`, under Pi's `CONFIG_DIR_NAME`. Set `PI_A2A_CONFIG` to use another file. The file is limited to 64 KiB and has one top-level `agents` object:

```json
{
  "agents": {
    "demo": {
      "url": "http://127.0.0.1:7777",
      "allowHttpLoopback": true
    },
    "remote": {
      "url": "https://agent.example.com",
      "bearerTokenEnv": "REMOTE_A2A_TOKEN",
      "allowedOrigins": ["https://cards.example.com"]
    }
  }
}
```

| Field                     | Purpose                                                                                       |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `url`                     | Explicit agent endpoint. HTTPS is required unless you enable HTTP loopback for local use.     |
| `allowHttpLoopback`       | Set `true` only to permit HTTP for `localhost`, `127.0.0.1`, or `[::1]`.                      |
| `allowedOrigins`          | Additional exact trusted origins. Agent Cards cannot authorize a new origin.                  |
| `bearerTokenEnv`          | Name of an environment variable holding an outbound bearer token.                             |
| `bearerTokenFile`         | Absolute path to a file containing an outbound bearer token. Use instead of `bearerTokenEnv`. |
| `incomingBearerTokenFile` | Host-only peer credential reference used by `peerBearerAuth`; it is not exposed in discovery. |

The config accepts credential references, not literal tokens or shell commands. Use `bearerTokenEnv` or `bearerTokenFile`, never both. File-backed credentials are read for requests, not exported to the whole Pi process. Keep credential files private (mode `600`) and outside Git; do not put config or credentials in public dotfiles.

Endpoint URLs cannot contain credentials, query strings, or fragments. HTTPS is the default; HTTP is limited to explicitly enabled loopback. Redirects are rejected. pi-a2a has no hostname detection, ambient cluster, network scan, or cross-host fallback. Unknown agents fail closed. A missing default config gives you an empty list; a missing explicitly selected config is an error.

## Compatibility

Requires Pi 1.5.0 or newer, Pi Durable 1.5.0 or newer when you use the Durable adapter, and Node.js 22.19 or newer. Tested with Pi and Pi Durable 1.5.2. CI tests Pi 1.5.0 and 1.5.2 and checks the latest Pi release weekly. Pi Durable integration is experimental; a new Durable release can change APIs that pi-a2a uses.

The package uses the official `@a2a-js/sdk` 1.3.0 and implements A2A protocol 1.0. The Durable server exposes JSON-RPC over HTTP, Agent Card discovery, send/get/list/cancel tasks, cursor pagination, follow-ups, status and artifact streaming, and task subscription. The client negotiates JSON-RPC or HTTP+JSON/REST through the official SDK, so it can talk to non-Pi implementations that expose those interfaces. gRPC and A2A v0.3 compatibility are not enabled. Authentication, supported media, and advertised capabilities must match between peers.

The Durable adapter does not support extended Agent Cards, protocol extensions, or `referenceTaskIds`. Streaming reports task state, fixed progress descriptions, and committed final artifacts; it does not promise provider-token streaming or byte-for-byte replay of an old stream.

## Privacy and security

pi-a2a connects only to configured endpoints. It does not scan networks, forward the Pi transcript, or treat Agent Cards and replies as instructions, approval, or authority to change the session's rules. Send only the context needed for the authorized request.

- **Credentials.** Keep credentials in environment variables or private files, never in model-visible arguments, source, or transcripts. The client sends them only to an explicitly trusted origin and rejects redirects. Pi tool errors sanitize remote diagnostics that could contain credentials.
- **Origins and transport.** HTTPS is required by default. Enable HTTP only for a loopback development endpoint. Server requests require authentication by default, and non-loopback traffic must use TLS. Secure other routes on a shared listener separately.
- **Attachments.** pi-a2a never fetches attachment URLs or opens host files. Document extraction runs locally in bounded workers; extracted text is untrusted input. Image bytes go to the existing Harness only when you explicitly enable images.
- **Responses.** Complete JSON responses are capped at 2 MiB. Tool text and result frames are bounded. Non-text artifact URLs are references, not downloaded files. Host-owned file routes must enforce their own authentication and byte limits.
- **Peer mesh.** Peer credentials are separate from the human owner's token. Authenticated peer identity is recorded as provenance, not owner approval. A shared private conversation is not multi-user isolation.

To report a vulnerability privately, use [SECURITY.md](https://github.com/leocavalcante/pi-a2a/blob/main/SECURITY.md). Do not include credentials, tokens, private endpoint URLs, prompts, session data, or project files in a public issue.

## Troubleshooting

- **An agent is missing.** Check the machine-local `agents.json`, the name passed to the tool, and the configured endpoint. Unknown agents do not fall back to discovery.
- **Authentication or origin fails.** Keep the endpoint HTTPS, check the private credential reference, and add only explicitly trusted `allowedOrigins`. Agent Cards cannot extend trust.
- **A send is uncertain.** Inspect its original `messageId` or `taskId` with `a2a_get_task` or `/a2a result`. Do not send it again with a new ID.
- **Observation pauses.** Remote work may continue. Read the retained task or reopen the eligible Pi history to retry observation. A paused observer does not cancel the task.
- **An attachment is rejected.** Check the opt-in input mode, media type, limits, and HTTP body ceiling. pi-a2a does not truncate oversized files.

## Contributing

See [CONTRIBUTING.md](https://github.com/leocavalcante/pi-a2a/blob/main/CONTRIBUTING.md) for development setup, verification, and release process.

## License

MIT. See [LICENSE](https://github.com/leocavalcante/pi-a2a/blob/main/LICENSE). pi-a2a uses the [official A2A JS SDK](https://github.com/a2aproject/a2a-js), not a handwritten replacement for its wire types or dispatch.
