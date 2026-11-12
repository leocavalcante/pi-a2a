import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { setImmediate as turn } from "node:timers/promises";
import {
  Message,
  StreamResponse,
  Task,
  TaskState,
  TaskStatus,
} from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { LocalA2AError } from "../src/client.ts";
import type { AgentConfig } from "../src/config.ts";
import { registerA2A } from "../src/extension.ts";
import {
  completionKind,
  fingerprint,
  history,
  observeTask,
  Output,
  readyRecord,
  validWatch,
  watchKind,
  type Reply,
  type Watch,
} from "../src/observation.ts";
import { changedUntil, deferred, Peer, task } from "./fixtures/completion.ts";

const config: AgentConfig = {
  agents: { sample: { url: "https://synthetic.invalid" } },
};
const identity = { taskId: "task-1", contextId: "context-1" };
const admitted = (sessionId = "session-1") => ({
  version: 1 as const,
  phase: "admitted" as const,
  sessionId,
  agent: "sample",
  endpoint: fingerprint(config, "sample"),
  messageId: "message-1",
  toolCallId: "tool-1",
  policy: "display" as const,
  ...identity,
});

async function local(
  peer = new Peer(),
  manager = SessionManager.inMemory(),
  mode: ExtensionContext["mode"] = "tui",
) {
  const changes = new EventEmitter(),
    tools = new Map<string, ToolDefinition>();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  type Injection = {
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: Parameters<ExtensionAPI["sendMessage"]>[1];
  };
  const injections: Injection[] = [],
    notices: string[] = [];
  const widgets = new Map<string, string[]>();
  let busy = false,
    persistMessages = true,
    target = structuredClone(config),
    beforeConnect: (() => void) | undefined;
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    sessionManager: manager,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => {
        notices.push(message);
        changes.emit("change");
      },
      theme: {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      setWidget: (key: string, lines: string[] | undefined) => {
        if (lines) widgets.set(key, lines);
        else widgets.delete(key);
        changes.emit("change");
      },
    },
  } as unknown as ExtensionContext;
  const persist = (injection: Injection) => {
    const message = injection.message;
    manager.appendCustomMessageEntry(
      message.customType,
      message.content,
      message.display,
      message.details,
    );
    changes.emit("change");
  };
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
      return () => {};
    },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (
      name: string,
      command: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) => commands.set(name, command),
    appendEntry: (kind: string, data: unknown) => {
      manager.appendCustomEntry(kind, data);
      changes.emit("change");
    },
    sendMessage: (
      message: Injection["message"],
      options: Injection["options"],
    ) => {
      const injection = { message, options };
      injections.push(injection);
      if (persistMessages) persist(injection);
      if (options?.triggerTurn) busy = true;
      changes.emit("change");
    },
  } as unknown as ExtensionAPI;
  const emit = async (name: string) => {
    if (name === "agent_settled") busy = false;
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  registerA2A(pi, {
    loadConfig: async () => target,
    connect: async () => {
      beforeConnect?.();
      return peer.client;
    },
  });
  await emit("session_start");
  return {
    peer,
    pi,
    ctx,
    manager,
    changes,
    injections,
    notices,
    widgets,
    tools,
    emit,
    persist,
    busy: (value: boolean) => {
      busy = value;
    },
    persistMessages: (value: boolean) => {
      persistMessages = value;
    },
    target: (value: AgentConfig) => {
      target = value;
    },
    onConnect: (check: () => void) => {
      beforeConnect = check;
    },
    wait: (condition: () => boolean) => changedUntil(changes, condition),
    send: async (
      messageId = "message-1",
      wait?: boolean,
      taskId?: string,
      signal?: AbortSignal,
    ) => {
      const value = await tools.get("a2a_send")!.execute(
        `tool-${messageId}`,
        {
          agent: "sample",
          message: "Synthetic authorized text",
          messageId,
          ...(wait === undefined ? {} : { wait }),
          ...(taskId ? { taskId } : {}),
        },
        signal,
        undefined,
        ctx as never,
      );
      assert.ok(Value.Check(Output, value.structuredContent));
      return value.structuredContent as Reply;
    },
    command: (args: string) => commands.get("a2a")!.handler(args, ctx as never),
    shutdown: () => emit("session_shutdown"),
  };
}

test("TUI admission retains intent/admission and observes with an independent signal", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.onConnect(() =>
    assert.ok(
      h.manager
        .getBranch()
        .some(
          (entry) => entry.type === "custom" && entry.customType === watchKind,
        ),
    ),
  );
  h.peer.read = (id) => {
    assert.ok(
      [...history(h.ctx).records.values()].some(
        (record) => record.phase === "admitted",
      ),
    );
    return h.peer.tasks.get(id)!;
  };
  const originalTurn = new AbortController();
  const reply = await h.send(
    "message-1",
    undefined,
    undefined,
    originalTurn.signal,
  );
  originalTurn.abort();
  assert.equal(reply.watching, true);
  assert.equal(reply.state, "TASK_STATE_WORKING");
  assert.equal(h.peer.sent[0].configuration?.returnImmediately, true);
  assert.equal(h.peer.sent[0].message?.messageId, reply.messageId);
  const records = h.manager
    .getBranch()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === watchKind,
    );
  assert.deepEqual(
    records.map(
      (entry) => entry.type === "custom" && (entry.data as Watch).phase,
    ),
    ["intent", "admitted"],
  );
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  h.peer.settle();
  await h.wait(() => h.injections.length === 1);
  assert.equal(h.injections[0].message.customType, completionKind);
  assert.equal(h.injections[0].options?.triggerTurn, true);
  assert.equal(h.injections[0].options?.deliverAs, "followUp");
  assert.match(
    String(h.injections[0].message.content),
    /Synthetic remote answer/,
  );
  await h.emit("agent_settled");
  await turn();
  assert.equal(h.injections.length, 1);
  assert.equal(h.peer.sent.length, 1);
  assert.equal(h.peer.cancellations, 0);
});

test("reads do not enroll historical tasks or start subscriptions", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.peer.tasks.set(
    "historical",
    task(TaskState.TASK_STATE_COMPLETED, "Retained answer", "historical"),
  );
  const reply = await h.tools
    .get("a2a_get_task")!
    .execute(
      "inspection",
      { agent: "sample", taskId: "historical" },
      undefined,
      undefined,
      h.ctx as never,
    );
  assert.equal((reply.structuredContent as Reply).text, "Retained answer");
  await h.command("result sample historical");
  await turn();
  assert.equal(history(h.ctx).records.size, 0);
  assert.equal(h.peer.subscriptions.length, 0);
  assert.equal(h.peer.sent.length, 0);
});

test("navigation during an uncertain command send cannot append admission or its answer into another history", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  const before = h.manager.appendCustomEntry("before-command", {});
  const entered = deferred(),
    release = deferred();
  const original = h.peer.client.transport.sendMessage.bind(
    h.peer.client.transport,
  );
  h.peer.client.transport.sendMessage = async (request, options) => {
    const value = await original(request, options);
    entered.resolve();
    await release.promise;
    return value;
  };
  const send = h.command("send sample Synthetic delayed admission");
  await entered.promise;
  h.manager.branch(before);
  await h.emit("session_tree");
  release.resolve();
  await send;
  await turn();
  assert.equal(h.injections.length, 0);
  assert.equal(history(h.ctx).records.size, 0);
  assert.equal(h.peer.sent.length, 1);
  assert.equal(h.peer.subscriptions.length, 0);
  assert.equal(h.widgets.size, 0);
});

test("observer deduplication binds endpoint, task and message identities, not just the message ID", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.busy(true);
  const first = await h.send("same-message");
  // An explicitly repeated send to a non-idempotent peer can admit a distinct task; never overwrite the first watch.
  const second = await h.send("same-message");
  assert.notEqual(first.taskId, second.taskId);
  await changedUntil(h.peer.events, () => h.peer.active === 2);
  h.peer.settle(
    "task-1",
    TaskState.TASK_STATE_COMPLETED,
    "First admitted task",
  );
  h.peer.settle(
    "task-2",
    TaskState.TASK_STATE_COMPLETED,
    "Second admitted task",
  );
  await h.wait(
    () =>
      [...history(h.ctx).records.values()].filter(
        (record) => record.phase === "ready",
      ).length === 2,
  );
  await h.emit("agent_settled");
  await h.wait(() => h.injections.length === 1);
  await h.emit("agent_settled");
  await h.wait(() => h.injections.length === 2);
  assert.notEqual(
    (h.injections[0].message.details as { taskId: string }).taskId,
    (h.injections[1].message.details as { taskId: string }).taskId,
  );
});

test("repeated registration of the same admitted task reuses its observer and delivery", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  await h.send("idempotent-peer");
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  h.peer.direct = h.peer.tasks.get("task-1");
  await h.send("idempotent-peer");
  await turn();
  assert.equal(h.peer.subscriptions.length, 1);
  h.peer.settle();
  h.peer.settle();
  await h.wait(() => h.injections.length === 1);
  await h.emit("agent_settled");
  await turn();
  assert.equal(h.injections.length, 1);
});

test("busy Pi retains ready state outside the SDK queue; simultaneous tasks drain serially", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.busy(true);
  await h.send("first");
  await h.send("second");
  h.peer.settle("task-1", TaskState.TASK_STATE_COMPLETED, "First result");
  h.peer.settle("task-2", TaskState.TASK_STATE_COMPLETED, "Second result");
  await h.wait(
    () =>
      [...history(h.ctx).records.values()].filter(
        (record) => record.phase === "ready",
      ).length === 2,
  );
  assert.equal(h.injections.length, 0);
  assert.match(
    [...h.widgets.values()].flat().join("\n"),
    /Response ready; waiting for Pi/,
  );
  await h.emit("agent_settled");
  await h.wait(() => h.injections.length === 1);
  await turn();
  assert.equal(h.injections.length, 1);
  await h.emit("agent_settled");
  await h.wait(() => h.injections.length === 2);
  assert.match(String(h.injections[0].message.content), /First result/);
  assert.match(String(h.injections[1].message.content), /Second result/);
  assert.equal(h.widgets.size, 0);
});

test("a queued but unpersisted injection is not acknowledged, and reopening recovers it", async (t) => {
  const h = await local();
  h.persistMessages(false);
  await h.send();
  h.peer.settle();
  await h.wait(() => h.injections.length === 1);
  await h.emit("agent_settled");
  await turn();
  assert.equal(h.injections.length, 1);
  assert.equal(history(h.ctx).delivered.size, 0);
  await h.shutdown();
  const reopened = await local(h.peer, h.manager);
  t.after(reopened.shutdown);
  await reopened.wait(() => reopened.injections.length === 1);
  assert.match(
    String(reopened.injections[0].message.content),
    /Synthetic remote answer/,
  );
  assert.equal(history(reopened.ctx).delivered.size, 1);
  assert.equal(h.peer.sent.length, 1);
});

test("synchronous delivery errors pause once, sanitize diagnostics and retain the ready result for reopen", async (t) => {
  const h = await local();
  h.pi.sendMessage = () => {
    throw new Error("synthetic-private-runtime-diagnostic");
  };
  await h.send();
  h.peer.settle();
  await h.wait(() => h.notices.length === 1);
  assert.ok(!h.notices[0].includes("synthetic-private"));
  assert.ok(
    [...history(h.ctx).records.values()].some(
      (record) =>
        record.phase === "paused" &&
        record.reply?.text === "Synthetic remote answer",
    ),
  );
  await h.shutdown();
  const reopened = await local(h.peer, h.manager);
  t.after(reopened.shutdown);
  await reopened.wait(() => reopened.injections.length === 1);
  assert.match(
    String(reopened.injections[0].message.content),
    /Synthetic remote answer/,
  );
});

test("persisted custom-message acknowledgement suppresses delivery after reopen without a later marker", async (t) => {
  const h = await local();
  await h.send();
  h.peer.settle();
  await h.wait(() => history(h.ctx).delivered.size === 1);
  await h.shutdown();
  const reopened = await local(h.peer, h.manager);
  t.after(reopened.shutdown);
  await turn();
  await turn();
  assert.equal(reopened.injections.length, 0);
  assert.equal(h.peer.sent.length, 1);
});

test("legacy, malformed and uncertain intent entries do not enroll arbitrary tasks", async (t) => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("pi-a2a.receipt", {
    ...identity,
    messageId: "legacy",
    agent: "sample",
  });
  manager.appendCustomEntry(watchKind, {
    ...admitted(manager.getSessionId()),
    version: 2,
  });
  manager.appendCustomEntry(watchKind, {
    ...admitted(manager.getSessionId()),
    endpoint: "not-a-fingerprint",
  });
  const {
    taskId: _task,
    contextId: _context,
    ...intent
  } = admitted(manager.getSessionId());
  manager.appendCustomEntry(watchKind, { ...intent, phase: "intent" });
  const h = await local(new Peer(), manager);
  t.after(h.shutdown);
  await turn();
  await turn();
  assert.equal(h.peer.reads.length, 0);
  assert.equal(h.injections.length, 0);
});

test("navigation before the watch excludes stale callbacks; descendant growth and alternate histories remain eligible", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  const before = h.manager.appendCustomEntry("before-watch", {});
  await h.send();
  const admissionLeaf = h.manager.getLeafId()!;
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  h.manager.branch(before);
  await h.emit("session_tree");
  assert.equal(h.widgets.size, 0);
  h.peer.settle();
  await turn();
  await turn();
  assert.equal(h.injections.length, 0);
  h.manager.branch(admissionLeaf);
  await h.emit("session_tree");
  h.manager.appendCustomEntry("ordinary-growth", {});
  await h.wait(() => h.injections.length === 1);
  const firstKey = (h.injections[0].message.details as { deliveryKey: string })
    .deliveryKey;
  await h.emit("agent_settled");
  h.manager.branch(admissionLeaf);
  await h.emit("session_tree");
  await h.wait(() => h.injections.length === 2);
  assert.equal(
    (h.injections[1].message.details as { deliveryKey: string }).deliveryKey,
    firstKey,
  );
});

test("forked session IDs never inherit parent watch ownership, and compaction retains branch records", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.busy(true);
  await h.send();
  h.peer.settle();
  await h.wait(() =>
    [...history(h.ctx).records.values()].some(
      (record) => record.phase === "ready",
    ),
  );
  const leaf = h.manager.getLeafId()!;
  h.manager.appendCompaction(
    "Synthetic summary without watch data",
    leaf,
    1000,
  );
  assert.equal(
    [...history(h.ctx).records.values()].filter(
      (record) => record.phase === "ready",
    ).length,
    1,
  );
  const foreign = SessionManager.inMemory();
  for (const entry of h.manager.getBranch())
    if (entry.type === "custom" && entry.customType === watchKind)
      foreign.appendCustomEntry(watchKind, entry.data);
  const fork = await local(h.peer, foreign);
  t.after(fork.shutdown);
  await turn();
  await turn();
  assert.equal(fork.injections.length, 0);
  await h.emit("agent_settled");
  await h.wait(() => h.injections.length === 1);
});

test("retargeted or removed aliases fail closed before reconnect or delivery", async (t) => {
  const targets: AgentConfig[] = [
    { agents: {} },
    { agents: { sample: { url: "https://different.invalid" } } },
  ];
  for (const target of targets) {
    const h = await local();
    t.after(h.shutdown);
    h.busy(true);
    await h.send();
    h.peer.settle();
    await h.wait(() =>
      [...history(h.ctx).records.values()].some(
        (record) => record.phase === "ready",
      ),
    );
    h.target(target);
    await h.emit("agent_settled");
    await h.wait(() => h.notices.length === 1);
    assert.equal(h.injections.length, 0);
    assert.equal(h.peer.sent.length, 1);
    await h.emit("agent_settled");
    await turn();
    assert.equal(h.notices.length, 1);
  }
});

test("unsupported streaming pauses once without inventing task failure or polling", async (t) => {
  const peer = new Peer();
  peer.agentCard.capabilities!.streaming = false;
  const h = await local(peer);
  t.after(h.shutdown);
  const reply = await h.send();
  assert.equal(reply.state, "TASK_STATE_WORKING");
  await h.wait(() => h.notices.length === 1);
  assert.match(h.notices[0], /STREAMING_UNAVAILABLE/);
  assert.match(
    [...h.widgets.values()].flat().join("\n"),
    /Observation paused; remote work may continue/,
  );
  assert.equal(h.injections.length, 0);
  assert.equal(peer.reads.length, 1);
  assert.equal(peer.subscriptions.length, 0);
  assert.equal(peer.cancellations, 0);
});

test("inline Messages, settled Tasks and explicit foreground waits never enqueue automatic duplicates", async (t) => {
  for (const direct of [
    Message.fromJSON({
      messageId: "direct",
      contextId: "context-1",
      role: "ROLE_AGENT",
      parts: [{ text: "Inline result" }],
    }),
    task(TaskState.TASK_STATE_COMPLETED, "Inline result"),
  ]) {
    const peer = new Peer();
    peer.direct = direct;
    const h = await local(peer);
    t.after(h.shutdown);
    const reply = await h.send();
    assert.equal(reply.text, "Inline result");
    assert.equal(reply.watching, false);
    await turn();
    assert.equal(h.injections.length, 0);
    assert.equal(peer.subscriptions.length, 0);
  }
  const h = await local();
  t.after(h.shutdown);
  h.peer.read = (id) =>
    task(TaskState.TASK_STATE_COMPLETED, "Foreground result", id);
  assert.equal((await h.send("foreground", true)).text, "Foreground result");
  await turn();
  assert.equal(h.injections.length, 0);
  assert.equal(h.peer.subscriptions.length, 0);
});

test("an identical send settled inline clears its earlier observer's progress row", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  await h.send("same-id");
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  h.peer.direct = task(TaskState.TASK_STATE_COMPLETED, "Inline settled result");
  const reply = await h.send("same-id");
  assert.equal(reply.text, "Inline settled result");
  assert.equal(reply.watching, false);
  await changedUntil(h.peer.events, () => h.peer.active === 0);
  assert.equal(h.widgets.size, 0);
  assert.equal(h.injections.length, 0);
});

test("print, JSON and RPC retain foreground defaults and false non-TUI watching receipts", async (t) => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = await local(new Peer(), SessionManager.inMemory(), mode);
    t.after(h.shutdown);
    h.peer.read = (id) =>
      task(TaskState.TASK_STATE_COMPLETED, "Inline mode result", id);
    assert.equal((await h.send(`default-${mode}`)).text, "Inline mode result");
    const reply = await h.send(`receipt-${mode}`, false);
    assert.equal(reply.watching, false);
    assert.equal(reply.state, "TASK_STATE_WORKING");
    assert.equal(h.peer.subscriptions.length, 0);
  }
});

test("new authorized input rearms an interrupted task with a new message identity", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  await h.send("first-epoch");
  h.peer.settle(
    "task-1",
    TaskState.TASK_STATE_INPUT_REQUIRED,
    "Human input needed",
  );
  await h.wait(() => h.injections.length === 1);
  await h.emit("agent_settled");
  await h.send("second-epoch", false, "task-1");
  h.peer.settle(
    "task-1",
    TaskState.TASK_STATE_COMPLETED,
    "Answer after authorized input",
  );
  await h.wait(() => h.injections.length === 2);
  assert.notEqual(
    (h.injections[0].message.details as { deliveryKey: string }).deliveryKey,
    (h.injections[1].message.details as { deliveryKey: string }).deliveryKey,
  );
  assert.match(
    String(h.injections[1].message.content),
    /Answer after authorized input/,
  );
  assert.equal(h.peer.sent.length, 2);
});

test("observation delivers authoritative snapshots for every significant state without subscribing", async () => {
  for (const state of [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ]) {
    const peer = new Peer();
    peer.tasks.set(
      "task-1",
      task(
        state,
        state === TaskState.TASK_STATE_COMPLETED
          ? ""
          : "Required action/outcome",
      ),
    );
    const result = await observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
    );
    assert.equal(result.status?.state, state);
    assert.equal(peer.subscriptions.length, 0);
    const ready = readyRecord(admitted(), result);
    assert.ok(validWatch(ready));
    assert.equal(
      ready.reply.text,
      state === TaskState.TASK_STATE_COMPLETED ? "" : "Required action/outcome",
    );
  }
});

test("subscribe rejection after completion and EOF without a final event reconcile through GetTask", async () => {
  for (const reject of [true, false]) {
    const peer = new Peer();
    peer.tasks.set("task-1", task());
    peer.stream = async function* () {
      peer.tasks.set(
        "task-1",
        task(TaskState.TASK_STATE_COMPLETED, "Authoritative result"),
      );
      if (reject) throw new UnsupportedOperationError();
      yield StreamResponse.fromJSON({
        artifactUpdate: {
          taskId: "task-1",
          contextId: "context-1",
          artifact: {
            artifactId: "partial",
            parts: [{ text: "Not the final answer" }],
          },
        },
      });
    };
    const result = await observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
    );
    assert.equal(
      readyRecord(admitted(), result).reply.text,
      "Authoritative result",
    );
    assert.equal(peer.reads.length, 2);
    assert.equal(peer.active, 0);
  }
});

test("repeated initial snapshot plus EOF exhausts five unproductive cycles with bounded backoff", async () => {
  const peer = new Peer();
  peer.tasks.set("task-1", task());
  peer.stream = async function* () {
    yield StreamResponse.fromJSON({ task: Task.toJSON(task()) });
  };
  const waits: number[] = [];
  await assert.rejects(
    observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    ),
    /OBSERVATION_PAUSED/,
  );
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
  assert.equal(peer.subscriptions.length, 5);
  assert.equal(peer.active, 0);
});

test("meaningful progress resets the budget, while repeated identical artifacts do not", async () => {
  const peer = new Peer();
  peer.tasks.set("task-1", task());
  peer.stream = async function* () {
    yield StreamResponse.fromJSON({
      artifactUpdate: {
        taskId: "task-1",
        contextId: "context-1",
        artifact: {
          artifactId: "partial",
          parts: [{ text: "Meaningful progress" }],
        },
      },
    });
  };
  const waits: number[] = [];
  await assert.rejects(
    observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    ),
    /OBSERVATION_PAUSED/,
  );
  assert.deepEqual(waits, [1000, 1000, 2000, 4000, 8000]);
  assert.equal(peer.subscriptions.length, 6);
});

test("transport timeouts renew healthy streams without imposing a task deadline", async () => {
  const peer = new Peer();
  peer.tasks.set("task-1", task());
  let now = 0,
    connections = 0;
  peer.stream = async function* () {
    now += 330_000;
    throw new DOMException("Synthetic timeout", "TimeoutError");
  };
  const result = await observeTask(
    identity,
    async () => {
      if (++connections === 2)
        peer.tasks.set(
          "task-1",
          task(TaskState.TASK_STATE_COMPLETED, "Long task result"),
        );
      return peer.client;
    },
    new AbortController().signal,
    { sleep: async () => {}, now: () => now },
  );
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(connections, 2);
  assert.equal(peer.cancellations, 0);
});

test("mismatched task/context stream events are rejected before another task can be delivered", async () => {
  for (const wrong of [
    task(TaskState.TASK_STATE_COMPLETED, "Wrong answer", "another-task"),
    task(
      TaskState.TASK_STATE_COMPLETED,
      "Wrong answer",
      "task-1",
      "another-context",
    ),
  ]) {
    const peer = new Peer();
    peer.tasks.set("task-1", task());
    peer.stream = async function* () {
      yield StreamResponse.fromJSON({ task: Task.toJSON(wrong) });
    };
    await assert.rejects(
      observeTask(
        identity,
        async () => peer.client,
        new AbortController().signal,
      ),
      /INVALID_CORRELATION/,
    );
    assert.equal(peer.reads.length, 1);
    assert.equal(peer.active, 0);
  }
});

test("permanent credential errors do not retry; unknown diagnostics never escape exhausted observation", async () => {
  let connections = 0;
  await assert.rejects(
    observeTask(
      identity,
      async () => {
        connections++;
        throw new LocalA2AError("CREDENTIAL_MISSING");
      },
      new AbortController().signal,
    ),
    /credential/,
  );
  assert.equal(connections, 1);
  const peer = new Peer();
  peer.read = () => {
    throw new Error("Bearer synthetic-private-diagnostic");
  };
  await assert.rejects(
    observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
      { sleep: async () => {} },
    ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "OBSERVATION_PAUSED");
      return true;
    },
  );
});

test("shutdown aborts local streams, not remote work, and late callbacks cannot append", async () => {
  const h = await local();
  await h.send();
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  await h.shutdown();
  const entries = h.manager.getEntries().length;
  h.peer.settle();
  await turn();
  await turn();
  assert.equal(h.peer.active, 0);
  assert.equal(h.peer.cancellations, 0);
  assert.equal(h.manager.getEntries().length, entries);
  assert.equal(h.injections.length, 0);
  assert.equal(h.widgets.size, 0);
});

test("nonterminal status events update only the widget, without transcript or follow-up spam", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  await h.send();
  await changedUntil(h.peer.events, () => h.peer.active === 1);
  const updated = task(
    TaskState.TASK_STATE_WORKING,
    "Searching the synthetic catalog",
  );
  h.peer.tasks.set("task-1", updated);
  h.peer.publish(
    "task-1",
    StreamResponse.fromJSON({
      statusUpdate: {
        taskId: "task-1",
        contextId: "context-1",
        status: TaskStatus.toJSON(updated.status!),
      },
    }),
  );
  await h.wait(() =>
    [...h.widgets.values()]
      .flat()
      .join("\n")
      .includes("Searching the synthetic catalog"),
  );
  assert.equal(h.injections.length, 0);
  assert.doesNotMatch(
    JSON.stringify(h.manager.getEntries()),
    /Searching the synthetic catalog/,
  );
  assert.equal(h.peer.sent.length, 1);
  assert.equal(h.peer.subscriptions.length, 1);
  h.peer.settle();
  await h.wait(() => h.injections.length === 1 && h.widgets.size === 0);
});

test("a failed or uncertain admission clears its sending widget but retains the original intent", async (t) => {
  const h = await local();
  t.after(h.shutdown);
  h.peer.client.transport.sendMessage = async () => {
    throw new Error("Synthetic uncertain send");
  };
  assert.equal((await h.send()).ok, false);
  assert.equal(h.widgets.size, 0);
  assert.ok(
    [...history(h.ctx).records.values()].some(
      (record) => record.phase === "intent",
    ),
  );
  assert.equal(h.peer.subscriptions.length, 0);
});

test("progress callbacks reject mismatched identities before displaying another task's text", async () => {
  const peer = new Peer();
  peer.tasks.set("task-1", task());
  peer.stream = async function* () {
    yield StreamResponse.fromJSON({
      statusUpdate: {
        taskId: "other-task",
        contextId: "context-1",
        status: task(
          TaskState.TASK_STATE_WORKING,
          "Another task's private status",
        ).status,
      },
    });
  };
  const updates: unknown[] = [];
  await assert.rejects(
    observeTask(
      identity,
      async () => peer.client,
      new AbortController().signal,
      {
        onProgress: (update) => {
          updates.push(update);
        },
      },
    ),
    /INVALID_CORRELATION/,
  );
  assert.doesNotMatch(JSON.stringify(updates), /Another task/);
});

test("completion framing is JSON-escaped/Unicode bounded, marked truncated and rejects malformed records", () => {
  for (const text of ["😀".repeat(20_000), '\u0000"\n'.repeat(20_000)]) {
    const ready = readyRecord(
      admitted(),
      task(TaskState.TASK_STATE_COMPLETED, text),
    );
    assert.ok(validWatch(ready));
    assert.equal(ready.reply.truncated, true);
    assert.ok(!ready.reply.text!.includes("\ufffd"));
    assert.ok(Buffer.byteLength(JSON.stringify(ready.reply.text)) <= 32_768);
    assert.equal(validWatch({ ...ready, deliveryKey: "a".repeat(64) }), false);
    assert.equal(
      validWatch({
        ...ready,
        reply: { ...ready.reply, state: "TASK_STATE_WORKING" },
      }),
      false,
    );
    assert.equal(
      validWatch({
        ...ready,
        credential: "synthetic-never-persist-credentials",
      }),
      false,
    );
  }
});
