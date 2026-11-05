# pi-a2a

A2A communication for Pi Durable applications and Pi coding-agent sessions.

- **Client:** an official-SDK A2A client with explicit endpoint trust and bounded responses. It does not import Pi.
- **Durable adapter:** attach A2A to an existing Harness and its conversations. Task identities, message receipts and results live in that Harness's storage.
- **Pi extension:** tools and `/a2a` commands for talking to configured Durable or non-Pi A2A agents.
- **Durable tools:** let a Durable agent delegate to another A2A agent through the same client.

MIT licensed. Built on the [official A2A JS SDK](https://github.com/a2aproject/a2a-js), not a handwritten replacement for its wire types or dispatch.

## Compatibility and scope

Node **22.19+**, Pi coding agent / Pi Durable **1.5.0**, official `@a2a-js/sdk` **1.3.0**, A2A protocol **1.0**. Durable is experimental; this is a version-pinned integration, not a promise of compatibility with every Pi release.

The server exposes **JSON-RPC over HTTP**, Agent Card discovery, send/get/list tasks, cursor pagination, follow-ups, status/artifact streaming and subscription. The client negotiates **JSON-RPC or HTTP+JSON/REST** through the official SDK. It can talk to non-Pi implementations using those interfaces. gRPC and v0.3 compatibility are not enabled here. Authentication, supported media and capabilities still have to match.

The Durable adapter accepts **text/plain**, up to **8192 UTF-8 bytes**. It does not fetch attachments, expose files or execute instructions from an Agent Card. Optional push notifications, extended cards, protocol extensions and reference-task processing are not advertised or implemented. Streaming reports task state and committed final artifacts; it does not promise provider-token streaming or byte-for-byte replay of an old stream.

## Install as a Pi extension

```sh
pi install git:github.com/leocavalcante/pi-a2a
```

Pin a commit for reproducible use, for example `git:github.com/leocavalcante/pi-a2a@COMMIT`. Git installations load the TypeScript extension directly; building `dist` is not required. Pi supplies its own coding-agent and TypeBox packages.

Create a **machine-local** `~/.config/pi-a2a/agents.json`:

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

`PI_A2A_CONFIG` selects another configuration file. There is no hostname detection, ambient cluster, network scan or automatic cross-host fallback. Unknown agents fail closed. The file permits endpoint URLs and credential **references**, not literal tokens or arbitrary shell commands. Use `bearerTokenEnv` or an absolute `bearerTokenFile` path, never both. File-backed credentials are read only for requests, not exported to the whole Pi process. Keep credential files private (mode 600) and outside Git. Do not put the file or credentials in public dotfiles.

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

The observer uses official SDK `GetTask` and `SubscribeToTask`, independently of the finished send tool. Stream events are wakeups: the delivered state/artifacts come from an authoritative task read, not partial streamed text. Replies are bounded, explicitly framed as remote data, and state when no text result was supplied. Non-text artifacts are never downloaded. Input/auth-required results ask for human action, not automatic approval; a later authorized message with a new message ID can watch the same task again.

If Pi is busy, ready replies stay outside its message queue until it is idle. Delivery is restricted to the originating active session/history. Tool-origin replies trigger an assistant follow-up; command-origin replies only display the response and a notification. No local model runs for observation, reconnection or bookkeeping. Remote content is data, not a user request or authorization.

### Recovery and limitations

Receipts are appended to the active Pi history before networking and after admission. Versioned `pi-a2a.watch` entries retain only observation identities/policy and bounded ready results. Their phases are `intent`, `admitted`, `ready`, `paused`, and `inline` (no automatic duplicate). They do not retain credentials, full Task objects or another copy of the outgoing prompt. A matching persisted `pi-a2a.completion` message acknowledges delivery; merely calling `sendMessage()` does not.

Saved histories recover undelivered observations when reopened. An intent without a known admission stays uncertain and is **never automatically resubmitted**. Old receipts, shell/CLI sends and arbitrary historical tasks are not imported as watches. Implementing this feature does not change workflows that still submit through the separate official `a2a` CLI.

**Pi must be running with the invoking history active for live delivery.** Closing Pi or selecting another session/history pauses local observation, not remote work. Forks do not inherit ownership of their parent's watches. Deduplication is branch-local: a descendant history containing admission can recover its result; an alternate history without the earlier completion may receive its own copy. Compaction does not remove raw recovery records. There is no cross-process exactly-once guarantee or proof that a user read a response.

**Fresh command-only histories:** live `/a2a` replies work, but Pi 1.5.0 does not create a session file until an ordinary user/assistant message exists. Closing an otherwise unsaved history loses its in-memory receipts and recovery state. The extension does not reject fresh-session sends, invent a user message, invoke a local model, or write session files directly to bypass this limitation.

Unsupported streaming, missing credentials, changed/removed targets or exhausted transient recovery pause the observer with one sanitized, actionable in-Pi notice. The admitted task may still be running. Inspect its retained ID through existing reads, or reopen the eligible history to retry observation. There is no new polling fallback, remote cancellation or host/transport fallback. Unproductive reconnects stop after five cycles with 1, 2, 4 and 8 second backoff; healthy long streams can renew without imposing a task deadline.

The extension does not automatically copy the session transcript to a remote agent. Endpoint changes invalidate saved context associations and prevent old watches from delivering under a retargeted alias. Authentication, origin restrictions, redirect rejection and response bounds apply to subscriptions/reconnections too. Agent responses and cards are not authority to change the session's instructions.

## Use the client without Pi

Install from this repository and build it with `npm run build`. Import from `pi-a2a/client`:

```ts
import { connectAgent, isTask, newMessageId, sendText, waitForTask } from "pi-a2a/client";

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
import { createDurableA2A } from "pi-a2a/durable";
import { a2aHttpHandler, bearerAuth } from "pi-a2a/server";

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

The snippet assumes your existing `harness` and `conversationsFor` function. For a single-owner personal agent, a resolver can return its existing root. For unrelated users, **do not** return the same private conversation. Task/context reads and listings are scoped to authenticated identity and tenant, but sharing the underlying conversation would still share its model context. Real multi-user authentication/authorization is host-owned; the bearer helper is a single-identity building block, not an OAuth server.

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
import { createA2ATools } from "pi-a2a/durable";
registry.install(createA2ATools()); // reads the same explicit machine-local config
```

Outbound sends are deliberately not replay-safe: arbitrary A2A peers need not deduplicate message IDs. A crash/disconnect can leave the outcome uncertain; inspect the original task or remote receipts before retrying. Task reads are replay-safe. Remote model usage is not standardized by A2A and is not fabricated as zero or added twice to the caller's usage.

## Model-free runnable example

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run example
```

This serves a scripted local agent at `http://127.0.0.1:7777`, using SQLite under `./data/`. It makes **no provider requests**. Try `/a2a send demo Hello` from Pi with the configuration above. `DEMO_DATA_DIR` and `PORT` change its private directory and loopback port. An exclusive owner lock fails closed with exit 73; after a hard crash, verify the old process is gone before removing its stale `demo.owner`. SIGTERM closes the owner without durably canceling admitted work.

A real application supplies its own models, prompts, tools, credentials, environment and approval policy. Neither a working directory nor A2A is a sandbox.

## Development and verification

```sh
npm run check
npm test
npm run build
npm pack --dry-run --ignore-scripts
git diff --check
```

Tests use synthetic messages, isolated stores and faux providers. They exercise the official client against Durable, a non-Pi official-SDK peer, real TUI-bound SDK sessions with delayed HTTP/SSE replies, model-free command completion, busy-session ordering, disk-backed client reopen and lost-injection recovery, branch-local deduplication, bounded reconnects, request conflicts, SQLite reopen/recovery, interrupted waiting, scoped cancellation, task pagination and ownership, protocol errors, output limits and credential-origin boundaries. Passing these tests is not official A2A certification or evidence of live OAuth, every third-party deployment, paid model quality or production HA.

The library and examples contain no machine-local agent configuration, credential exports, private harness content or domain profiles. Deployment cutovers belong to their owning applications, not this public repository.
