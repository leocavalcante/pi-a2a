import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type LiveState } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Message, SendMessageRequest, TaskState } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isTask, sendText, textOf, waitForTask, streamText } from "../src/client.ts";
import { context, fixture } from "./fixtures/agent.ts";
import { changedUntil, deferred } from "./fixtures/completion.ts";

const completed = async (f: Awaited<ReturnType<typeof fixture>>, text = "Hello", id = "message-1", contextId?: string) => {
  const value = await sendText(f.client, text, { messageId: id, contextId });
  assert.ok(isTask(value));
  const task = await waitForTask(f.client, value.id, { intervalMs: 10 });
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  return task;
};

test("official SDK client drives a real Durable submission and context follow-up", async t => {
  const f = await fixture({ answers: ["First answer", "Second answer"] }); t.after(f.close);
  const one = await completed(f);
  assert.equal(textOf(one), "First answer");
  assert.notEqual(one.id, "message-1");
  const two = await completed(f, "Follow-up", "message-2", one.contextId);
  assert.equal(two.contextId, one.contextId);
  assert.notEqual(two.id, one.id);
  assert.equal(textOf(two), "Second answer");
  assert.equal(f.faux.state.callCount, 2);
});

test("concurrent identical message IDs admit once; changed text conflicts", async t => {
  const f = await fixture(); t.after(f.close);
  const replies = await Promise.all(Array.from({ length: 4 }, () => sendText(f.client, "Same", { messageId: "same-id" })));
  assert.ok(replies.every(isTask));
  assert.equal(new Set(replies.map(reply => reply.id)).size, 1);
  await waitForTask(f.client, replies[0].id, { intervalMs: 10 });
  await assert.rejects(sendText(f.client, "Changed", { messageId: "same-id" }), /message ID already belongs/);
  assert.equal(f.faux.state.callCount, 1);
});

test("task and idempotency receipts survive SQLite reopen without another model call", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-reopen-"));
  const db = join(dir, "agent.sqlite");
  const f = await fixture({ storage: await openNodeSqliteStorage(db) }); t.after(f.close);
  const original = await completed(f, "Persist", "persist-id");
  await f.close();
  const reopened = await fixture({ storage: await openNodeSqliteStorage(db), answers: [] });
  try {
    const retained = await reopened.client.getTask({ id: original.id, tenant: "", historyLength: 0 });
    assert.deepEqual(retained, original);
    const duplicate = await sendText(reopened.client, "Persist", { messageId: "persist-id" });
    assert.ok(isTask(duplicate)); assert.equal(duplicate.id, original.id);
    assert.equal(textOf(duplicate), "Hello over A2A");
    assert.equal(reopened.faux.state.callCount, 0);
  } finally { await reopened.close(); await rm(dir, { recursive: true }); }
});

test("interrupted work resumes under the same task after graceful owner replacement", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-resume-"));
  const db = join(dir, "agent.sqlite");
  const f = await fixture({ storage: await openNodeSqliteStorage(db), tokensPerSecond: 5, answers: ["This answer is intentionally slow to let the owner stop during generation."] });
  t.after(f.close);
  const admitted = await sendText(f.client, "Resume me", { messageId: "resume-id" });
  assert.ok(isTask(admitted));
  while (f.faux.state.callCount === 0) await delay(10);
  await f.close();
  const reopened = await fixture({ storage: await openNodeSqliteStorage(db), answers: ["Recovered"] });
  try {
    const recovered = await waitForTask(reopened.client, admitted.id, { intervalMs: 10 });
    assert.equal(recovered.id, admitted.id);
    assert.equal(recovered.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(textOf(recovered), "Recovered");
    const duplicate = await sendText(reopened.client, "Resume me", { messageId: "resume-id" });
    assert.ok(isTask(duplicate)); assert.equal(duplicate.id, admitted.id);
    assert.equal(reopened.faux.state.callCount, 1); // Retry of interrupted inference, not a second admission.
  } finally { await reopened.close(); await rm(dir, { recursive: true }); }
});

test("local wait cancellation does not cancel the remote submission", async t => {
  const f = await fixture({ tokensPerSecond: 40, answers: ["The remote answer continues after local waiting is interrupted."] }); t.after(f.close);
  const value = await sendText(f.client, "Keep working", { messageId: "disconnect-id" }); assert.ok(isTask(value));
  const controller = new AbortController();
  const waiting = waitForTask(f.client, value.id, { signal: controller.signal, intervalMs: 10 });
  controller.abort(); await assert.rejects(waiting);
  const task = await waitForTask(f.client, value.id, { intervalMs: 20 });
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.faux.state.callCount, 1);
});

test("a lost blocking response can be retried by message ID without a second admission", async t => {
  const f = await fixture({ tokensPerSecond: 20, answers: ["The first request is already admitted and will finish once."] }); t.after(f.close);
  const controller = new AbortController();
  const pending = sendText(f.client, "Lost acknowledgement", { messageId: "lost-ack", returnImmediately: false, signal: controller.signal });
  const observed = pending.catch(error => error);
  while (f.faux.state.callCount === 0) await delay(10);
  controller.abort();
  assert.ok(await observed instanceof Error);
  const retried = await sendText(f.client, "Lost acknowledgement", { messageId: "lost-ack" }); assert.ok(isTask(retried));
  assert.equal((await waitForTask(f.client, retried.id, { intervalMs: 20 })).status?.state, TaskState.TASK_STATE_COMPLETED);
  const list = await f.client.listTasks({ tenant: "", contextId: "", status: 0, pageToken: "", statusTimestampAfter: undefined });
  assert.equal(list.tasks.length, 1); assert.equal(f.faux.state.callCount, 1);
});

test("queued task can be canceled without aborting the active conversation", async t => {
  const f = await fixture({ tokensPerSecond: 30, answers: ["Active request stays alive and finishes normally.", "This response must not be consumed."] }); t.after(f.close);
  const first = await sendText(f.client, "Active", { messageId: "active" }); assert.ok(isTask(first));
  while (f.faux.state.callCount === 0) await delay(10);
  const second = await sendText(f.client, "Queued", { messageId: "queued" }); assert.ok(isTask(second));
  const canceled = await f.client.cancelTask({ id: second.id, tenant: "", metadata: undefined });
  assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
  await assert.rejects(f.client.cancelTask({ id: first.id, tenant: "", metadata: undefined }), /cannot be canceled independently/);
  assert.equal((await waitForTask(f.client, first.id, { intervalMs: 20 })).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.faux.state.callCount, 1);
});

test("application-declared input-required task accepts follow-up, not terminal-task reuse", async t => {
  const f = await fixture({ answers: ["Need input", "Finished", "New task"], classifyAnswer: answer => answer === "Need input" ? TaskState.TASK_STATE_INPUT_REQUIRED : TaskState.TASK_STATE_COMPLETED }); t.after(f.close);
  const value = await sendText(f.client, "Start", { messageId: "turn-1" }); assert.ok(isTask(value));
  const paused = await waitForTask(f.client, value.id, { intervalMs: 10 });
  assert.equal(paused.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
  const follow = await sendText(f.client, "Details", { messageId: "turn-2", taskId: value.id }); assert.ok(isTask(follow));
  assert.equal(follow.id, value.id);
  assert.equal(textOf(await waitForTask(f.client, follow.id, { intervalMs: 10 })), "Finished");
  await assert.rejects(sendText(f.client, "Another", { messageId: "turn-3", taskId: value.id }), /terminal task/);
  const fresh = await completed(f, "Another", "turn-4", value.contextId);
  assert.notEqual(fresh.id, value.id);
});

test("task ownership and unknown contexts fail closed", async t => {
  const f = await fixture(); t.after(f.close);
  const task = await completed(f);
  const stranger = new ServerCallContext({ user: { isAuthenticated: true, userName: "different-user" }, requestedVersion: "1.0" });
  await assert.rejects(f.adapter.getTask({ id: task.id, tenant: "" }, stranger), /not found/i);
  const own = new ServerCallContext({ user: { isAuthenticated: true, userName: "loopback-owner" }, requestedVersion: "1.0" });
  const foreignList = await f.adapter.listTasks({ tenant: "", contextId: "", status: 0, pageToken: "", statusTimestampAfter: undefined }, stranger);
  assert.deepEqual(foreignList.tasks, []);
  await assert.rejects(sendText(f.client, "Hello", { messageId: "bad-context", contextId: "unknown-context" }), /not found/i);
  await assert.rejects(f.adapter.getTask({ id: task.id, tenant: "unauthorized" }, own), /tenant/);
});

test("listing uses cursor pages, filtering and omitted artifacts", async t => {
  const f = await fixture({ answers: ["One", "Two", "Three"] }); t.after(f.close);
  for (let i = 0; i < 3; i++) await completed(f, `Text ${i}`, `page-${i}`);
  const query = { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageSize: 2, pageToken: "", statusTimestampAfter: undefined, includeArtifacts: false, historyLength: 0 };
  const one = await f.client.listTasks(query);
  assert.equal(one.tasks.length, 2); assert.ok(one.nextPageToken);
  assert.ok(one.tasks.every(task => !task.artifacts.length && !task.history.length));
  const two = await f.client.listTasks({ ...query, pageToken: one.nextPageToken });
  assert.equal(two.tasks.length, 1); assert.equal(two.nextPageToken, "");
  assert.equal(new Set([...one.tasks, ...two.tasks].map(task => task.id)).size, 3);
  await assert.rejects(f.client.listTasks({ ...query, pageToken: one.nextPageToken, contextId: "different-query" }), /query/);
  const raw = await fetch(`${f.baseUrl}/a2a`, { method: "POST", headers: { "Content-Type": "application/json", "A2A-Version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ListTasks", params: { pageSize: 2 } }) });
  const document = await raw.json() as { result: { tasks: object[] } };
  assert.ok(document.result.tasks.every(task => !Object.hasOwn(task, "artifacts")));
});

test("stream starts with a task, publishes a final artifact and can be reattached", async t => {
  const f = await fixture({ tokensPerSecond: 80, answers: ["A streamed final answer is retained after disconnecting the first stream."] }); t.after(f.close);
  const controller = new AbortController();
  const stream = streamText(f.client, "Stream", { messageId: "stream-id", signal: controller.signal });
  const first = await stream.next();
  assert.equal(first.value?.payload?.$case, "task");
  const task = first.value!.payload!.$case === "task" ? first.value!.payload!.value : undefined; assert.ok(task);
  controller.abort(); await stream.return(undefined);
  const events = [];
  for await (const event of f.client.resubscribeTask({ id: task.id, tenant: "" })) events.push(event);
  assert.equal(events[0].payload?.$case, "task");
  assert.ok(events.some(event => event.payload?.$case === "artifactUpdate"));
  assert.equal((await waitForTask(f.client, task.id, { intervalMs: 10 })).status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(f.faux.state.callCount, 1);
});

test("invalid history and empty-list filters are rejected before admission", async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "bad-history", role: "ROLE_USER", parts: [{ text: "Must not run" }] }, configuration: { historyLength: -1 } })), /historyLength/);
  const query = { tenant: "", contextId: "", status: TaskState.TASK_STATE_UNSPECIFIED, pageToken: "", statusTimestampAfter: undefined };
  await assert.rejects(f.client.listTasks({ ...query, historyLength: -1 }), /historyLength/);
  await assert.rejects(f.client.listTasks({ ...query, status: TaskState.UNRECOGNIZED }), /state/);
  assert.equal(f.faux.state.callCount, 0);
});

test("progress is stable, submission-scoped, and reports completed tool counts without private data", async t => {
  const registry = createRegistry(), entered = [deferred(), deferred()], release = [deferred(), deferred()];
  registry.install(defineExtension({ name: "progress-test", tools: [defineTool({
    name: "hold", description: "Synthetic gated tool", parameters: { type: "object", properties: { index: { type: "number" } } },
    async execute(args) {
      const index = (args as { index: number }).index;
      entered[index].resolve(); await release[index].promise;
      return { output: [{ type: "text", text: "synthetic-private-tool-output" }] };
    },
  })] }));
  const f = await fixture({ registry });
  t.after(async () => { release.forEach(item => item.resolve()); await f.close(); });
  f.faux.setResponses([
    fauxAssistantMessage([fauxText("synthetic-private-commentary"), fauxToolCall("hold", { index: 0 }), fauxToolCall("hold", { index: 1 })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Final answer")]),
  ]);
  const watch = await f.root.watch(context), events = new EventEmitter();
  watch.start(async () => { events.emit("change"); }); t.after(() => watch.stop());
  const active = await sendText(f.client, "Run synthetic tools", { messageId: "progress-tools" }); assert.ok(isTask(active));
  await Promise.all(entered.map(item => item.promise));
  const first = await f.client.getTask({ id: active.id, tenant: "", historyLength: 0 });
  assert.equal(textOf(first), "Running tools (0/2 complete)");
  assert.doesNotMatch(JSON.stringify(first), /synthetic-private/);
  assert.deepEqual(await f.client.getTask({ id: active.id, tenant: "", historyLength: 0 }), first);
  const queued = await sendText(f.client, "Queued synthetic request", { messageId: "progress-queued" }); assert.ok(isTask(queued));
  assert.equal(queued.status?.state, TaskState.TASK_STATE_SUBMITTED); assert.equal(textOf(queued), "Queued");
  assert.doesNotMatch(JSON.stringify(queued), /Running tools|synthetic-private/);
  await f.client.cancelTask({ id: queued.id, tenant: "", metadata: undefined });
  release[0].resolve();
  await changedUntil(events, () => (watch.value.docs["pi.live"] as LiveState | undefined)?.tools?.filter(tool => tool.status === "done").length === 1);
  const advanced = await f.client.getTask({ id: active.id, tenant: "", historyLength: 0 });
  assert.equal(textOf(advanced), "Running tools (1/2 complete)");
  assert.notEqual(advanced.status?.message?.messageId, first.status?.message?.messageId);
  release[1].resolve();
  const done = await waitForTask(f.client, active.id, { intervalMs: 10 });
  assert.equal(textOf(done), "Final answer"); assert.equal(f.faux.state.callCount, 2);
});

test("unsupported content and invalid UTF-8 byte lengths never admit model work", async t => {
  const f = await fixture(); t.after(f.close);
  await assert.rejects(f.client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "file", role: "ROLE_USER", parts: [{ url: "https://example.invalid/input", mediaType: "image/png" }] } })), /content|media/i);
  assert.throws(() => sendText(f.client, "😀".repeat(2049), { messageId: "too-many-bytes" }), /8192/);
  assert.equal(f.faux.state.callCount, 0);
});
