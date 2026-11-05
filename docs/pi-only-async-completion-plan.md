# Pi-only asynchronous A2A completion: implementation handoff

Status: implemented and locally verified (77/77 model-free tests). Package publication, deployment and workflow adoption remain separate.

Prepared: 2026-11-05.

Repository baseline: `leocavalcante/pi-a2a`, branch `main`, commit
`7005f1d914f82249222a182f532424cd753ba21f`. The worktree and staging area
were clean before this plan was added. Recheck the repository before starting;
these observations are not permission to discard subsequent changes.

## Preflight finding and clarified scope (2026-11-05)

A real Pi 1.5.0 SDK session bound with `mode: "tui"` confirms that a fresh
command-only history is not written to disk. `/a2a send` appends its intent and
admission receipts and its displayed custom message in memory, but the session
file still does not exist after the synthetic remote task completes. No local
model is invoked. Quitting before an ordinary user/assistant message loses that
history, so it cannot be reopened to recover observations.

Reproducer in `tests/extension.test.ts`:

```sh
node --import tsx --test --test-timeout=20000 \
  --test-name-pattern='fresh command-only' tests/extension.test.ts
```

This is a passing characterization test of the SDK limitation, not an
asynchronous-completion acceptance test. The original baseline passed all 41
tests before this reproducer was added.

Pi's session writer intentionally defers creating the file until it contains a
user or assistant message (`SessionManager._hasConversation()` and `_persist()`
in the installed SDK). `pi.appendEntry()` and display-only `pi.sendMessage()` do
not satisfy that condition. Extensions receive a read-only session manager and
have no public flush operation.

This limitation does not prevent live replies in the invoking Pi session. The
clarified requirement prioritizes that behavior, including fresh command-only
histories. Do not reject those sends merely because the history is not saved.

Append identity before networking, and retain full reopen recovery for saved
histories. Document that closing a still-unsaved command-only history loses its
in-memory recovery state. Do not write session files directly, invent a user
message, invoke a local model for commands, or patch Pi core to force persistence.

## 1. Problem, outcome, and boundaries

A user should be able to delegate a long-running task from Pi, receive an
immediate admission receipt, continue the conversation, and receive the remote
answer automatically when it is ready. The user should not have to ask Pi to
check again. The LLM should not spend turns polling.

The existing flow successfully retains remote task identities and can retrieve
results, but has no background completion delivery after a foreground observer
returns or times out. A completed remote task can therefore remain invisible
until someone explicitly retrieves it. This is a client lifecycle/delivery gap,
not evidence that the remote agent failed or that its execution was slow.

### Required outcome

For interactive Pi TUI sends made through this extension:

1. Append the outgoing message identity before networking. Saved histories persist
   it; fresh command-only histories retain it in memory until Pi saves the history.
2. Submit with A2A `returnImmediately: true`.
3. Return the admitted task identity without waiting for remote completion.
4. Observe the existing task in the extension, independently of the tool call.
5. Retrieve the authoritative task and its artifacts when it completes or needs
   attention.
6. Deliver a bounded completion message into the originating active Pi history.
7. For model-issued sends, automatically start a follow-up assistant response.
8. Recover undelivered observations when that same saved session/history is reopened.

Pi must be running with the originating session/history active for live delivery.
While Pi is closed or another session/history is active, there is no live
notification guarantee. Reopening an eligible saved history must reconcile the
retained task and deliver any missing result. The fresh command-only persistence
limitation above does not block live delivery.

### Explicit non-goals

- No phone, Slack, email, desktop, terminal OSC, or external push service.
- No daemon, systemd service, Kubernetes resource, public listener, webhook,
  tunnel, new database, or global task registry.
- No changes to remote agents, their Durable adapters, models, permissions,
  credentials, deployments, or storage ownership.
- No new CLI, public tool, command family, configuration format, or dependency.
- No automatic discovery/import of tasks submitted through arbitrary shell/CLI
  commands, old sessions, abandoned branches, or other applications.
- No new polling fallback for peers without streaming. Existing explicit
  foreground waiting remains available.
- No automatic resubmission, approval, authentication fulfillment, cancellation,
  artifact download, provider-token streaming, or usage-accounting changes.
- No cross-process exactly-once guarantee or coordination between two Pi
  processes editing the same session file.
- No automatic upgrade, installation, publication, commit, push, or rollout.

## 2. Verified baseline and implementation preflight

The repository currently targets:

- Node 22.19 or newer.
- Pi coding agent and Pi Durable 1.5.0.
- Official `@a2a-js/sdk` 1.3.0 and A2A protocol 1.0.

These versions were also present in the local development dependencies when
this plan was written. Do not upgrade them to implement this feature.

### Relevant code at the recorded baseline

| Path | Current responsibility / observation |
| --- | --- |
| `src/extension.ts` | Registers four A2A tools and `/a2a`; writes `pi-a2a.receipt` entries before networking and after admission. |
| `src/extension.ts`, `send()` | Always submits asynchronously at the protocol level, but optionally calls `waitForTask()` before returning. |
| `src/extension.ts`, `a2a_send` | Omitted `wait` currently means `true`. |
| `src/extension.ts`, `/a2a send` | Currently waits for completion and deliberately does not invoke a local Pi model. |
| `src/client.ts`, `waitForTask()` | Foreground `GetTask` loop, default interval 500 ms; not a background notification manager. |
| `src/client.ts`, `connectAgent()` | Native official-SDK client, origin/redirect protections, credential callbacks, bounded JSON responses, 330,000 ms default request timeout. |
| `src/config.ts` | Explicit machine-local targets and credential references. Reuse it unchanged unless a directly required defect is demonstrated. |
| `src/durable.ts` | Server supports status/artifact streams and subscriptions; webhook push is explicitly unsupported. No production change is required here. |
| `tests/extension.test.ts` | Tool/schema tests, real Pi SDK session tests, and the command's no-local-model contract. |
| `tests/fixtures/agent.ts` | Model-free Durable peer with streaming and a faux provider. |
| `tests/http.test.ts`, `tests/rest.test.ts` | Official-SDK interoperability, transport, authentication, origin, and output-boundary tests. |
| `tests/recovery.test.ts` | Existing remote-task durability and no-fabricated-final-answer coverage. |

During the preceding research, a configured live agent advertised
`streaming: true` and `pushNotifications: false`. Treat that as evidence of a
usable current path, not a permanent assumption about every configured peer.

### Read before implementing

Resolve the actual installed packages, then read the matching documentation,
not a newer upstream API remembered from another environment:

- Pi package `README.md` and `docs/extensions.md` in full.
- Pi `docs/tui.md` for notification methods.
- Pi `docs/session-format.md` and the relevant SessionManager SDK documentation
  for branch-aware persistence.
- Pi examples `file-trigger.ts`, `message-renderer.ts`, and the state restoration
  portions of `todo.ts`. Reuse lifecycle patterns, not their unrelated features.
- Installed declarations for `ExtensionAPI`, `ExtensionContext`, session events,
  `CustomMessageEntry`, and the official A2A `Client`.

Observed API facts in Pi 1.5.0:

- `session_start` includes startup, reload, new, resume, and fork reasons.
- `session_shutdown` handles quit, reload, and session replacement.
- `/tree` changes the active branch without replacing the extension runtime;
  `session_tree` is required for reconciliation.
- There are no `session_switch` or `session_fork` after-events to invent here.
- `ctx.mode` distinguishes `tui`, `rpc`, `json`, and `print`; `ctx.hasUI` is also
  true in RPC mode, so it is not a TUI-mode discriminator.
- `pi.sendMessage()` returns `void`. A call returning is not proof that its
  message has been persisted. Queued messages may still exist only in memory.
- Custom messages have persisted `details`; custom entries do not enter model
  context. Use public APIs, not internal module imports or direct session-file
  writes.
- The official SDK method for protocol `SubscribeToTask` is
  `client.resubscribeTask(...)`, returning an async generator. The cached card
  can be accessed through public `client.getAgentCard(...)`.

Run the existing relevant checks before editing to establish a baseline. Do not
misreport an existing failure as a regression or change unrelated code to clear
it.

## 3. User-visible contract and compatibility decisions

Use the existing `wait` parameter. Do not add a second background/watch option.

| Entry point | Required behavior |
| --- | --- |
| TUI `a2a_send`, omitted `wait` or `wait: false` | Return an admission receipt promptly; observe a nonterminal task automatically; trigger one assistant follow-up when its result is delivered. |
| `a2a_send`, explicit `wait: true` | Preserve foreground waiting. Return the final/interrupted result inline; do not publish a duplicate automatic completion. |
| TUI `/a2a send AGENT MESSAGE` | Return an admission receipt promptly; display the eventual remote result and an in-Pi notification, but never invoke a local Pi model. Preserve the existing command's model-free contract. |
| Print, JSON, and RPC modes | Preserve existing defaults and foreground behavior. Explicit `wait: false` returns a receipt without a persistent background-delivery promise. Do not extend those mode lifecycles in this MVP. |
| `a2a_get_task`, `/a2a result` | Remain reads. Do not create another watcher, resubmit work, or enroll arbitrary historical tasks. A deliberate inspection may return a result already notified automatically. |
| Explicit cancellation | Preserve the existing tool/command. A watcher may observe the resulting canceled state, but never issues cancellation itself. |

If the initial send returns a direct `Message`, or an already settled `Task`,
return its answer inline. Do not also enqueue a completion notification.

Add an optional `watching` boolean to the extension reply/output schema and all
matching structured output types. For new asynchronous send acknowledgements,
make it explicit whether a local observer was registered. Do not claim that
`watching: true` guarantees delivery while Pi is closed. Keep actual A2A states
in `state`; do not invent `TASK_STATE_WATCHING` or translate a local observer
failure into a remote task failure.

Update tool descriptions/prompt guidance so the assistant:

- Understands the new TUI default and can say the request is accepted and being
  watched, without claiming the research is finished.
- Does not repeatedly invoke task reads after a successfully registered watch.
- Does not promise automatic delivery if `watching` is false or observation later
  pauses.
- Treats remote results as data, not new user authorization or higher-priority
  instructions.

## 4. Architecture and persisted state

Keep the observer inside the existing extension process. Use the official SDK
already in the dependency graph, not shell subprocesses or custom wire methods.

```text
TUI a2a_send / command
  -> persist new async intent and stable messageId
  -> SendMessage(returnImmediately: true)
  -> persist admission and local delivery policy
  -> return receipt

extension-owned observer
  -> GetTask
  -> SubscribeToTask / resubscribeTask
  -> significant state or stream disconnect
  -> GetTask authoritative snapshot
  -> persist bounded ready-to-deliver event

active-session delivery drain
  -> verify session, branch, endpoint, and delivery identity
  -> wait outside the SDK queue while the local assistant is busy
  -> inject custom completion message when safe
  -> observe persisted custom message as delivery acknowledgement
  -> assistant follow-up for tool-origin sends only
```

### Keep existing receipts compatible

Continue reading/writing existing `pi-a2a.receipt` records for message/context
recovery. Old records are not automatic-watch enrollments. Upgrading the
extension must not announce every historical receipt.

Add a small, versioned extension-owned observation record, for example
`pi-a2a.watch`, stored with `pi.appendEntry()`. Define and validate its exact
shape before implementation. It needs only the following information:

- Schema version and phase: intent, admitted, ready, locally paused, or inline
  (a response already returned by the caller, not eligible for automatic delivery).
- Originating Pi session ID; the record's ancestry in `getBranch()` supplies
  branch membership. Do not treat an unchanging leaf ID as branch identity,
  because ordinary conversation appends move the leaf.
- Agent alias and the existing endpoint fingerprint, not credentials or a
  credential-bearing URL.
- Stable initiating message ID and tool call ID where applicable.
- Task ID and context ID once admission is known.
- Delivery policy: assistant follow-up for tool-origin sends, display-only for
  command-origin sends.
- For a ready event: stable delivery key and the bounded normalized reply needed
  for later delivery. Do not retain entire Task objects, full histories, raw
  stream traffic, or duplicate outgoing prompts.

Persist intent before discovery/network I/O. Persist admission immediately after
receiving it, before launching the observer. If Pi stops after a send but before
receiving/persisting the task ID, keep this as an uncertain submission. Do not
assume `messageId` is a task ID or automatically repeat `SendMessage` to resolve
it. A retry of an uncertain send still requires the original retained identity
and existing reconciliation rules.

### Stable identities and interruption epochs

Deduplicate in-flight observers for the same session, endpoint, task, and
initiating message ID. A subsequent authorized message to a task awaiting
input/auth uses a new message ID and starts a new observation epoch. It must not
be suppressed because an earlier epoch already reported `INPUT_REQUIRED`.

Define a stable delivery key from endpoint fingerprint, task ID, initiating
message ID, reported state, and a digest of the normalized result. Do not use
local arrival time or stream connection ID. Include the key in the custom
message's persisted `details`.

### Persistence acknowledgement, not optimistic marking

A ready record must exist before requesting message injection. Maintain an
in-memory queued-key set to prevent duplicate injection before persistence.

Delivery is acknowledged by the actual matching `custom_message` entry in the
active branch, not by `pi.sendMessage()` returning. Use `message_end` and/or a
branch rescan to verify that entry exists. A separate acknowledgement marker may
be a convenience, but cannot replace this evidence.

On restoration:

- Ready record without a matching persisted completion message: deliver it.
- Matching persisted completion message: do not deliver again, even if a later
  bookkeeping marker is absent.
- Admitted record without a result: retrieve/observe the retained task.
- Intent without a task ID: retain uncertainty; do not send again.

This closes the common crash windows around in-memory queues and later
bookkeeping. It is not proof of user readership, exactly-once assistant model
execution, power-loss durability, or delivery across concurrent Pi processes.

## 5. A2A observation algorithm

Keep foreground `waitForTask()` and outbound Durable tools unchanged. Add only a
small internal observation helper/controller if needed to make this logic
independently testable; do not add a new public package entry point.

For each admitted asynchronous task:

1. Give observation its own `AbortController`. Do not tie its lifetime to the
   completed send tool's signal.
2. Revalidate the configured target/fingerprint before connecting. Use
   `configuredAgent()` and the existing guarded client so authentication,
   redirects, trusted origins, and response bounds remain enforced.
3. Call `GetTask` with no history. If already completed, failed, canceled,
   rejected, input-required, or auth-required, process that snapshot directly.
4. For an active task, require advertised streaming capability. Call the native
   `resubscribeTask({ id, tenant: "" }, { signal })`, preserving the existing
   tenant handling. Do not implement a bespoke `/events` endpoint.
5. Treat stream events as wakeups/status data, not the sole durable record.
   Validate correlation with the expected task/context. Fetch the current task
   before constructing a final delivery; do not hand-assemble an answer from
   partial artifact events.
6. If subscription is rejected because the task completed between the read and
   subscribe, fetch again and deliver the settled task. A terminal task need not
   support a new subscription.
7. If the stream closes without an observed settlement, fetch again before
   deciding whether to reconnect. EOF is not task completion.
8. Release the stream and local resources after a settled/interrupted result,
   local shutdown, or a bounded observation failure. Never call `CancelTask`.

The server sends an initial task snapshot on subscription, but reconnect does
not promise replay of every event. Always reconcile the authoritative task.

### Recovery bounds

Use fixed internal retry behavior, not new user configuration:

- Retry transient observation failures with bounded backoff. Proposed budget:
  five consecutive unproductive observation cycles, with 1, 2, 4, and 8 second
  waits between attempts. Inject timing in tests rather than sleeping.
- Repeated initial snapshots followed immediately by EOF count as unproductive;
  a successful nonterminal `GetTask` alone must not create a tight reconnect
  loop. Reset the failure budget on meaningful progress or a sustained healthy
  stream, not merely on opening a connection.
- The existing 330-second request/stream timeout may cause ordinary connection
  renewal for long tasks. Reconcile and reconnect; do not impose a 330-second
  task deadline or disable existing transport safety limits.
- Stop retrying immediately for known credential, authentication, trust, target,
  or capability errors. Report a sanitized local observation issue once and
  retain the original task receipt. Unknown raw remote diagnostics must not be
  printed.
- After exhausting transient recovery, pause this local observation with one
  actionable Pi notice. Remote work may still be running. Reopening/resuming the
  eligible session can retry the retained observation. Do not add a retry tool
  or silently switch transports/hosts.

If streaming is unavailable, return/preserve the admitted identity and clearly
state that automatic observation is unavailable. Never retry the send or
silently enter a new polling fallback. The user can explicitly inspect/wait via
existing tools.

## 6. Completion delivery and model behavior

Use a distinct custom message type such as `pi-a2a.completion`. Its local header
identifies the agent alias, task ID, actual state, and truncation status. Its
body contains bounded remote result text, explicitly delimited as remote data.
Persist correlation and delivery metadata in `details`, not in system
instructions.

Reuse `textOf()`, `boundedText()`, existing identity checks, and safe error
handling. Preserve the 32 KiB JSON-escaped text bound and reserve room for local
wrapping. Do not download non-text artifacts or fabricate an answer when a
completed task has no text. Report the actual state and the absence of a text
result. A thrown observer error must not be presented as `TASK_STATE_FAILED`.

### Tool-origin result

When the active session/history is eligible and the local assistant is idle,
inject a displayed custom message using the equivalent of:

```ts
pi.sendMessage(completionMessage, {
  triggerTurn: true,
  deliverAs: "followUp",
});
```

The resulting assistant turn should relay the answer or explain the required
human action. The custom event is not a new user request. Do not use
`sendUserMessage()` to impersonate user authorization. No model calls are needed
for admission bookkeeping, subscription, reconnection, or result retrieval.

### Busy assistant and scope safety

Do not rely on an SDK-queued custom message remaining attached to the original
branch after navigation. Keep ready results in extension-owned persisted state
while Pi is busy. Drain after `agent_settled`, outside the event's synchronous
callback if necessary, rechecking session generation, active branch membership,
endpoint fingerprint, duplicate keys, and `ctx.isIdle()` immediately before
injection. Serialize drains so simultaneous completions cannot start competing
local turns or inject the same event twice.

`nextTurn` is unsuitable: it would still require a new user prompt. Do not steer
an unrelated active task with remote progress updates.

### Command-origin result

Display the same bounded completion with `triggerTurn: false`, plus a short
`ctx.ui.notify()` message. It must invoke zero local Pi model requests, even
after the remote result arrives. A remote agent may still use its own model.

Use only in-Pi notifications, guarded appropriately for the supported mode. Do
not copy the native-terminal notification behavior from Pi's `notify.ts`
example. Progress snapshots do not need toast messages or model turns.

### States that deserve delivery

- `COMPLETED`: relay the actual result.
- `FAILED`, `CANCELED`, `REJECTED`: clearly relay the outcome without claiming
  successful research or automatically restarting it.
- `INPUT_REQUIRED`, `AUTH_REQUIRED`: ask for the required human action without
  granting it. Finish this observation epoch; a later authorized send can rearm
  the same task with a new message ID.

## 7. Session, branch, and configuration lifecycle

Register lifecycle handlers once per extension instance. Do not start network
work during module import/factory registration.

### `session_start`

- Reconstruct only versioned watch records and matching completion messages in
  `ctx.sessionManager.getBranch()`.
- Restore only records belonging to the current Pi session ID and matching
  currently configured endpoint fingerprint.
- Do not enroll legacy receipts or old foreground waits.
- Deliver pending ready events and start missing observers without awaiting a
  long-running subscription in the startup handler.
- Verify real SDK startup ordering in tests; do not trigger a follow-up against
  a half-bound runtime.

### `session_tree`

- Invalidate the old in-memory generation, abort its observers, and reconstruct
  from the newly active branch.
- Guard every asynchronous callback before session/UI writes. Comparing only a
  captured context object is insufficient because the underlying session manager
  can now point at another branch.
- Do not stop permanently from a cancellable before-navigation event alone.
- Normal conversation growth is not navigation. A changing leaf ID must not
  unnecessarily cancel active observers.

### `session_shutdown`

- Idempotently invalidate the instance and abort all local streams/timers.
- Do not cancel remote work or delete its recovery receipts.
- Do not wait indefinitely for cleanup or keep the process alive with timers.
- A late callback after shutdown must not append to the replacement session.

### Forks, alternate histories, and compaction

- Forked sessions must not automatically take ownership of pending watches
  created in their parent session. This prevents two sessions from announcing
  the same inherited task. Existing explicit task reads remain available.
- Within the original session, a selected descendant history containing the
  watch is eligible. A history before/without the watch is not.
- Deduplication is branch-local. An alternate history that contains admission
  but not the earlier delivery may legitimately receive its own completion when
  selected. Do not scan abandoned branches to impose global deduplication.
- Compaction must not erase recoverable observation state. Verify reconstruction
  from the actual branch entries, not from the model's summary prose.

### Changed or removed targets

Fail closed if the agent alias is removed or its endpoint fingerprint changes.
Do not deliver under a newly retargeted alias or reconnect using an old cached
client. Keep the original receipt and issue one sanitized local notice. Reuse
credential references transiently; never persist credential values or include
them in fingerprints, messages, diagnostics, or tests' failure output.

## 8. Suggested implementation sequence

1. **Preflight and baseline.** Confirm branch, HEAD, status, installed APIs, and
   baseline checks. Preserve unrelated work. Do not install or upgrade clients.
2. **Define records and reconstruction.** Add validated versioned observation
   state, stable delivery identity, current-branch reduction, and persisted-message
   deduplication. Test legacy and malformed records first.
3. **Implement the observation loop.** Use native SDK subscriptions, authoritative
   reads, bounded reconnects, and independent abort signals. Test without Pi or a
   model where possible.
4. **Wire asynchronous admission.** Change only the TUI default; retain explicit
   foreground waits and other modes. Persist intent/admission, register the
   observer, return a schema-valid receipt with honest `watching` metadata.
5. **Wire ready-event delivery.** Add safe idle draining, model follow-up for
   tool-origin sends, and model-free command completion. Acknowledge actual
   persisted custom messages, not queued calls.
6. **Wire lifecycle recovery.** Restore on startup/tree changes, shut down local
   resources safely, and prove no cross-session/history injection.
7. **Document and verify.** Update the owning README's tool defaults, commands,
   recovery semantics, mode limitations, and no-closed-Pi guarantee. Run all
   relevant checks and inspect packaging.

Expected production changes should be concentrated in `src/extension.ts` and,
if useful, one internal observation helper. `src/client.ts` may receive directly
required helper reuse, but must remain independent of Pi. Do not rewrite the
server, configuration system, Durable tools, or public exports.

Add focused tests in top-level `tests/*.test.ts` files so the existing test
script includes them. Extend existing fixtures only as needed. A small new
completion integration test file is preferable to broadly rewriting unrelated
tests.

## 9. Required automated test matrix

All checks must be model-free, with synthetic local data and the existing faux
provider or an official-SDK scripted peer. Use deferred gates/events and fake
clocks, not real network services, fixed long sleeps, or paid model calls.

| Area | Required evidence |
| --- | --- |
| Admission | TUI default returns while remote task is still gated/working; intent is present before any network I/O and admission is retained before observing. |
| Happy path | End the original local turn, release the remote task, and receive the answer automatically without another user prompt or task-read tool call. Exactly one automatic completion entry in that active history. |
| Real Pi integration | Exercise the extension through a real SDK session, not just a mock `sendMessage`. Bind it explicitly with `session.bindExtensions({ mode: "tui" })` or the equivalent public binding; SDK sessions default to print mode. Observe the automatic assistant response using events, not a second `session.prompt()`. |
| Model use | Observation/reconnects make no local model calls. Tool-origin completion causes the expected follow-up only. `/a2a send` remains at zero local model calls through eventual completion. |
| Inline results | Direct `Message`, already settled task, and explicit `wait: true` return inline without later automatic duplicates. |
| Modes | Print/JSON/RPC defaults remain unchanged; explicit non-TUI `wait: false` does not make a false background-delivery promise. |
| Busy Pi | Completion during another local run is retained and delivered afterward without steering it, invalid tool/result message ordering, or duplicate model turns. |
| Correlation | Ignore/reject mismatched task/context stream events; do not publish a different task's answer. |
| Races | Task completes between `GetTask` and subscription; completion occurs before first subscription; stream closes before its final event. All recover through `GetTask` without resending. |
| Reconnects | Transient disconnect, existing transport timeout, and multiple reconnects preserve task/message IDs. Repeated snapshot-plus-EOF does not busy-loop and eventually pauses with one local warning. |
| Unsupported/error paths | Streaming disabled/unsupported, missing credentials, changed origin, and exhausted retries preserve admission, sanitize diagnostics, and never masquerade as remote failure or invoke another transport/host. |
| Significant states | Completion, failure, cancellation, rejection, input-required, and auth-required each produce the correct non-fabricated outcome. New input with a new message ID rearms an interrupted task. |
| Duplicate events | Repeated artifacts, status updates, reconnect snapshots, and repeated registration cannot queue/deliver the same completion twice in one active history. |
| Simultaneous tasks | Two tasks completing together deliver their own answers, without overwriting correlation or starting conflicting drain operations. |
| Persistence windows | Reopen after admission, after persisting ready but before injection, while injection is queued/not persisted, and after custom-message persistence but before bookkeeping acknowledgement. No lost ready event and no duplicate persisted completion. |
| Session lifecycle | Reload/resume restores eligible work. Switch, shutdown, tree navigation before/after admission, and fork prevent stale callbacks from writing into another session/history. Ordinary new messages do not stop observation. |
| Branch semantics | Abandoned/legacy receipts do not enroll; alternate-history behavior matches the documented branch-local contract; compaction leaves recoverable records. |
| Bounds/security | Unicode and JSON-escaped oversized text remain bounded, truncation is explicit, no non-text artifacts are fetched, no raw credential-bearing exceptions appear, and existing redirect/origin checks still apply to subscriptions/reconnects. |
| Cleanup | Streams and timers end on shutdown/pause/settlement; local shutdown never sends `CancelTask`; cleanup does not leave hanging tests or unhandled rejections. |
| Packaging | New internal runtime imports are included in the package and load correctly without importing Pi into the generic client entry point. |

For persistence tests, use a task peer whose identity survives the local Pi
session reopen. Reopening only the remote Durable database does not establish
client notification recovery. Test the client's disk-backed session history and
queued-message loss explicitly.

If the current public Pi APIs cannot satisfy scope safety or delivery recovery,
stop and report the exact reproducible gap. Do not silently patch Pi core,
weaken branch isolation, or claim exactly-once delivery from a mock-only test.

## 10. Verification, handoff report, and adoption boundary

From the repository, run the owning checks:

```sh
npm run check
npm test
npm run build
npm pack --dry-run --ignore-scripts
git diff --check
```

Inspect the package contents and each exit status. Existing tests use a
20-second per-test limit and sequential test execution; deterministic gates and
injected clocks should keep the new tests comfortably within those limits.

A successful implementation report must state:

- Changed repository paths and the behavior/defaults that changed.
- Which of the required scenarios were actually exercised, with commands and
  results. Separate source-level/unit checks, real SDK integration, and any
  interactive TUI smoke test.
- Remaining limitations, including no notification while Pi is closed and no
  ownership of inactive sessions/branches.
- Whether the user workflow has actually adopted the extension or only the
  repository implementation is complete.

### Important adoption dependency

The current personal-agent messaging instructions direct requests through the
upstream `a2a` CLI on the owning host using private profiles. Those shell sends
do not pass through this extension and will not automatically create watches.
The Pi extension has its own separate machine-local configured-target file.

Consequently, implementing this repository feature alone does not change the
existing domain workflow. Do not claim that it does. Do not add a shell-output
scraper, CLI polling wrapper, implicit configuration conversion, or task scanner
to conceal the gap.

After repository verification, a separately authorized adoption step must choose
and validate the Pi extension path for the relevant workflows, preserving
explicit host routing, target configuration, credential references, privacy,
and domain approvals. That may require an owning instruction/configuration
change outside this repository. Do not perform it under this handoff's
repository-only implementation scope.

Use synthetic configured peers for development and smoke tests. Real-agent
requests, extension installation/reload in someone else's active session,
configuration/instruction edits, deployment, release, commit, and push require
their applicable authorization. Stop after the requested implementation and
checks; do not change unrelated remote tasks.

### Done criteria

The repository feature is done when a real Pi SDK TUI-bound session can submit
an intentionally delayed synthetic task, finish its original turn, and later
present the remote answer automatically in the correct active history without
another user message; disconnect/reopen cases retain identity and recover
undelivered results; commands remain model-free; the automated checks pass; and
the documented lifecycle, privacy, mode, and adoption boundaries are accurate.

Do not report deployment or workflow adoption as complete unless those later
stages were separately authorized and evidenced.

## Implementation verification (2026-11-05)

- `src/extension.ts` now defaults TUI sends to admission plus automatic observation;
  explicit foreground waits and non-TUI defaults are preserved. `/a2a` completion
  remains model-free.
- `src/observation.ts` owns validated versioned records, task/message/endpoint
  correlation, bounded native subscriptions, branch-aware lifecycle recovery,
  idle delivery and persisted-message acknowledgement. No public package entry
  point or configuration format was added.
- `src/client.ts` and `src/config.ts` propagate the observer's independent abort
  signal through discovery/requests. HTTP 401/403 outcomes are typed and sanitized
  so authentication failures pause observation instead of retrying blindly.
- Six real SDK sessions bound to TUI mode cover delayed official-SDK HTTP/SSE
  replies, zero-local-model command delivery in a fresh history, disk-backed
  admission recovery, real tree navigation, busy-tool ordering, and simulated
  injection loss followed by disk reopen and persisted-message deduplication.
  Unit/transport tests cover the remaining state, bounds, retry and scope cases.
- `npm run check`, `A2A_CLI_BIN=/path/to/a2a npm test`, `npm run build`,
  `npm pack --dry-run --ignore-scripts`, and `git diff --check` passed. The full
  suite passed 77 tests with no skips. Package inspection included the new helper
  in both `src` and `dist`.
- An isolated physical Pi TUI smoke test in a sibling tmux pane also passed:
  admission returned while the synthetic HTTP/SSE peer was gated, the session
  remained usable, and its matching reply and notification appeared automatically
  without another prompt or local model call. No live-agent request, deployment,
  package publication or workflow-adoption change was performed.
- Receipts and replies retain Pi's default renderer and global theme; the
  extension does not override their colors.
- Closed/inactive histories have no live-delivery guarantee; fresh command-only
  histories retain the documented Pi 1.5.0 save limitation.

## References

- [A2A streaming and asynchronous operations](https://a2a-protocol.org/v1.0.0/topics/streaming-and-async/)
- [A2A 1.0 specification](https://a2a-protocol.org/v1.0.0/specification/), especially
  GetTask, SubscribeToTask, and task lifecycle semantics.
- [Official JavaScript SDK](https://github.com/a2aproject/a2a-js); installed 1.3.0
  declarations are the API reference for this implementation.
- Repository `README.md`, `src/extension.ts`, `src/client.ts`, `src/config.ts`, and
  the tests identified above.
- Installed Pi 1.5.0 documentation and examples resolved under
  `node_modules/@earendil-works/pi-coding-agent/`.
