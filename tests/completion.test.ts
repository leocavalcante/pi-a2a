import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as turn } from "node:timers/promises";
import { TaskState } from "@a2a-js/sdk";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { fixture } from "./fixtures/agent.ts";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { registerA2A, type ExtensionOptions } from "../src/extension.ts";
import { completionKind, history, watchKind, type Reply } from "../src/observation.ts";
import { changedUntil, deferred, httpPeer, Peer } from "./fixtures/completion.ts";

async function sdk(dir: string, options: ExtensionOptions, script: ReturnType<typeof fauxAssistantMessage>[], manager = SessionManager.inMemory(dir), extra?: (pi: ExtensionAPI) => void,
  dropCompletion?: (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => boolean) {
  const faux = fauxProvider(); faux.setResponses(script);
  const events = new EventEmitter(), notices: string[] = [], errors: string[] = [], widgets = new Map<string, string[]>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models-cache.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [pi => {
      const wrapped = dropCompletion ? new Proxy(pi, { get(target, key) {
        if (key === "sendMessage") return (message: Parameters<ExtensionAPI["sendMessage"]>[0], delivery: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
          if (!dropCompletion(message)) target.sendMessage(message, delivery);
        };
        return Reflect.get(target, key);
      } }) : pi;
      registerA2A(wrapped, options); extra?.(pi);
    }] });
  await loader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off",
    noTools: "builtin", resourceLoader: loader, settingsManager: settings, sessionManager: manager });
  assert.deepEqual(extensionsResult.errors, []);
  session.subscribe(() => events.emit("change"));
  await session.bindExtensions({ mode: "tui", uiContext: {
    notify: (text: string) => { notices.push(text); events.emit("change"); },
    theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    setWidget: (key: string, lines: string[] | undefined) => { if (lines) widgets.set(key, lines); else widgets.delete(key); events.emit("change"); },
  } as unknown as ExtensionUIContext,
    onError: error => { errors.push(error.error); events.emit("change"); } });
  return { session, faux, manager, events, notices, errors, widgets,
    wait: (condition: () => boolean) => changedUntil(events, condition),
    completions: () => manager.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === completionKind),
    close: async () => {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    } };
}
const send = (messageId: string) => fauxAssistantMessage([fauxToolCall("a2a_send", { agent: "sample", message: "Synthetic authorized request", messageId })], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage([fauxText(text)]);
const peerOptions = (peer: Peer): ExtensionOptions => ({ loadConfig: async () => ({ agents: { sample: { url: "https://synthetic.invalid" } } }), connect: async () => peer.client });

async function directory(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-completion-")); t.after(() => rm(dir, { recursive: true })); return dir;
}

test("real TUI-bound Pi receives an HTTP/SSE answer and starts one follow-up after its original turn", async t => {
  const peer = await httpPeer(); t.after(peer.close);
  const dir = await directory(t);
  const s = await sdk(dir, { loadConfig: async () => ({ agents: { sample: { url: peer.baseUrl, allowHttpLoopback: true } } }) },
    [send("http-tool-origin"), say("Accepted; you can keep working."), say("Automatic remote answer relayed.")]);
  t.after(s.close);
  await s.session.prompt("Delegate the supplied synthetic text to sample.");
  assert.equal(s.session.getLastAssistantText(), "Accepted; you can keep working.");
  assert.equal(s.faux.state.callCount, 2); assert.equal(s.completions().length, 0);
  const receipt = s.session.messages.find(message => message.role === "toolResult" && message.toolName === "a2a_send");
  assert.equal(receipt?.role, "toolResult");
  if (receipt?.role === "toolResult") {
    const reply = receipt.details as Reply;
    assert.equal(reply.watching, true); assert.equal(reply.state, "TASK_STATE_WORKING"); assert.ok(reply.taskId);
  }
  await peer.subscribed.promise;
  peer.release.resolve("Authoritative delayed HTTP/SSE answer");
  await s.wait(() => s.session.getLastAssistantText() === "Automatic remote answer relayed.");
  await s.session.waitForIdle();
  assert.equal(s.completions().length, 1);
  assert.match(JSON.stringify(s.completions()), /Authoritative delayed HTTP\/SSE answer/);
  assert.equal(s.faux.state.callCount, 3);
  assert.deepEqual(peer.counts(), { sends: 1, cancels: 0, subscriptions: 1 });
  assert.deepEqual(s.errors, []);
});

test("/a2a returns admission then displays the answer in a fresh Pi session with zero local model calls", async t => {
  const peer = await httpPeer(); t.after(peer.close);
  const dir = await directory(t), manager = SessionManager.create(dir, join(dir, "sessions"));
  const s = await sdk(dir, { loadConfig: async () => ({ agents: { sample: { url: peer.baseUrl, allowHttpLoopback: true } } }) }, [], manager);
  t.after(s.close);
  await s.session.prompt("/a2a send sample A synthetic command request");
  const receipt = manager.getBranch().find(entry => entry.type === "custom_message" && entry.customType === "pi-a2a");
  assert.equal(receipt?.type, "custom_message");
  if (receipt?.type === "custom_message") assert.equal((receipt.details as Reply).watching, true);
  assert.equal(s.completions().length, 0); assert.equal(s.faux.state.callCount, 0);
  await assert.rejects(access(manager.getSessionFile()!), { code: "ENOENT" });
  await peer.subscribed.promise;
  peer.release.resolve("Automatic command reply, no local model");
  await s.wait(() => s.completions().length === 1 && s.notices.some(notice => notice.includes("response available")));
  assert.match(JSON.stringify(s.completions()), /Automatic command reply, no local model/);
  assert.equal(s.faux.state.callCount, 0); assert.deepEqual(s.errors, []);
  // Live delivery works even though Pi does not save a command-only history for reopen recovery.
  await assert.rejects(access(manager.getSessionFile()!), { code: "ENOENT" });
});

test("disk-backed Pi history reopens an admitted task without resubmitting it", async t => {
  const dir = await directory(t), manager = SessionManager.create(dir, join(dir, "sessions")), peer = new Peer();
  const first = await sdk(dir, peerOptions(peer), [send("disk-admitted"), say("Accepted")], manager);
  await first.session.prompt("Delegate this synthetic request.");
  await changedUntil(peer.events, () => peer.active === 1);
  const file = manager.getSessionFile()!, originalSession = manager.getSessionId();
  assert.match(await readFile(file, "utf8"), /pi-a2a.watch/);
  await first.close(); await changedUntil(peer.events, () => peer.active === 0);
  peer.settle("task-1", TaskState.TASK_STATE_COMPLETED, "Answer retained while Pi was closed");
  const reopenedManager = SessionManager.open(file);
  assert.equal(reopenedManager.getSessionId(), originalSession);
  const reopened = await sdk(dir, peerOptions(peer), [say("Restored remote answer")], reopenedManager); t.after(reopened.close);
  await reopened.wait(() => reopened.session.getLastAssistantText() === "Restored remote answer");
  await reopened.session.waitForIdle();
  assert.equal(reopened.completions().length, 1); assert.match(JSON.stringify(reopened.completions()), /Answer retained while Pi was closed/);
  assert.equal(peer.sent.length, 1); assert.equal(peer.sent[0].message?.messageId, "disk-admitted");
  assert.equal(peer.cancellations, 0); assert.deepEqual(reopened.errors, []);
});

test("real Pi tree navigation excludes abandoned history and restores the selected admission without resending", async t => {
  const dir = await directory(t), peer = new Peer();
  const s = await sdk(dir, peerOptions(peer), [send("tree-navigation"), say("Accepted"), say("Remote response on the original branch")]);
  t.after(s.close);
  await s.session.prompt("Delegate this synthetic request.");
  await changedUntil(peer.events, () => peer.active === 1);
  const admissionLeaf = s.manager.getLeafId()!;
  const before = s.manager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user")!.id;
  await s.session.navigateTree(before, { summarize: false });
  await changedUntil(peer.events, () => peer.active === 0);
  peer.settle("task-1", TaskState.TASK_STATE_COMPLETED, "Result retained off the active history");
  await turn(); await turn(); assert.equal(s.completions().length, 0);
  await s.session.navigateTree(admissionLeaf, { summarize: false });
  await s.wait(() => s.session.getLastAssistantText() === "Remote response on the original branch");
  await s.session.waitForIdle();
  assert.equal(s.completions().length, 1); assert.match(JSON.stringify(s.completions()), /Result retained off the active history/);
  assert.equal(peer.sent.length, 1); assert.equal(peer.cancellations, 0); assert.deepEqual(s.errors, []);
});

test("completion during unrelated local tool work waits for idle and preserves real Pi message ordering", async t => {
  const dir = await directory(t), peer = new Peer(), entered = deferred(), release = deferred();
  const hold = fauxAssistantMessage([fauxToolCall("hold_local", {})], { stopReason: "toolUse" });
  const s = await sdk(dir, peerOptions(peer), [send("busy-local"), say("Remote accepted"), hold, say("Unrelated local task finished"), say("Remote answer after local work")],
    SessionManager.create(dir, join(dir, "sessions")), pi => pi.registerTool({ name: "hold_local", label: "Synthetic local gate", description: "Synthetic test gate", parameters: { type: "object", properties: {} },
      async execute() { entered.resolve(); await release.promise; return { content: [{ type: "text", text: "Synthetic local tool finished" }], details: {} }; } }));
  t.after(async () => { release.resolve(); await s.close(); });
  await s.session.prompt("Delegate this synthetic request.");
  const localRun = s.session.prompt("Do an unrelated synthetic local task.");
  await entered.promise;
  peer.settle("task-1", TaskState.TASK_STATE_COMPLETED, "Background result while local work runs");
  await s.wait(() => managerReady(s.manager));
  assert.equal(s.completions().length, 0); assert.equal(s.faux.state.callCount, 3);
  release.resolve(); await localRun;
  await s.wait(() => s.session.getLastAssistantText() === "Remote answer after local work");
  await s.session.waitForIdle();
  assert.equal(s.completions().length, 1); assert.equal(s.faux.state.callCount, 5); assert.deepEqual(s.errors, []);
  const entries = s.manager.getBranch(), completion = entries.findIndex(entry => entry.type === "custom_message" && entry.customType === completionKind);
  const tool = entries.findIndex(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "hold_local");
  assert.ok(completion > tool);
});

function managerReady(manager: SessionManager) {
  return manager.getBranch().some(entry => entry.type === "custom" && entry.customType === watchKind && (entry.data as { phase?: string }).phase === "ready");
}

test("disk-backed ready event survives an SDK injection lost before persistence, then deduplicates after persistence", async t => {
  const dir = await directory(t), manager = SessionManager.create(dir, join(dir, "sessions")), peer = new Peer(), injected = deferred();
  let discarded = 0;
  const first = await sdk(dir, peerOptions(peer), [send("lost-queued-injection"), say("Accepted")], manager, undefined, message => {
    if (message.customType !== completionKind) return false;
    discarded++; injected.resolve(); return true;
  });
  await first.session.prompt("Delegate this synthetic request.");
  peer.settle("task-1", TaskState.TASK_STATE_COMPLETED, "Recovered queued completion");
  await injected.promise;
  assert.equal(discarded, 1); assert.equal(first.completions().length, 0); assert.equal(first.faux.state.callCount, 2);
  const file = manager.getSessionFile()!;
  const disk = SessionManager.open(file);
  assert.ok(managerReady(disk));
  assert.equal(disk.getBranch().filter(entry => entry.type === "custom_message" && entry.customType === completionKind).length, 0);
  await first.close();
  const second = await sdk(dir, peerOptions(peer), [say("Delivered after reopening")], SessionManager.open(file));
  await second.wait(() => second.session.getLastAssistantText() === "Delivered after reopening");
  await second.session.waitForIdle(); assert.equal(second.completions().length, 1);
  assert.match(JSON.stringify(second.completions()), /Recovered queued completion/);
  await second.close();
  // No acknowledgement marker was needed: the actual custom_message entry is the acknowledgement.
  const third = await sdk(dir, peerOptions(peer), [], SessionManager.open(file)); t.after(third.close);
  await turn(); await turn(); await turn();
  assert.equal(third.faux.state.callCount, 0); assert.equal(third.completions().length, 1);
  assert.equal(peer.sent.length, 1); assert.deepEqual(third.errors, []);
});

test("Durable stages reach a real Pi progress widget over HTTP/SSE without local model calls", async t => {
  const registry = createRegistry(), entered = deferred(), release = deferred();
  registry.install(defineExtension({ name: "synthetic-progress", tools: [defineTool({
    name: "hold", description: "A synthetic gated tool", parameters: { type: "object", properties: {} },
    async execute() { entered.resolve(); await release.promise; return { output: [{ type: "text", text: "Private tool result" }] }; },
  })] }));
  const f = await fixture({ registry, tokensPerSecond: 60 });
  t.after(async () => { release.resolve(); await f.close(); });
  f.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
    say("A synthetic final answer long enough to observe the next generation before this task completes."),
  ]);
  const dir = await directory(t);
  const s = await sdk(dir, { loadConfig: async () => ({ agents: { sample: { url: f.baseUrl, allowHttpLoopback: true } } }) }, []);
  t.after(s.close);
  await s.session.prompt("/a2a send sample A synthetic progress request");
  await entered.promise;
  const display = () => [...s.widgets.values()].flat().join("\n");
  await s.wait(() => display().includes("Running tools (0/1 complete)"));
  assert.match(display(), /watching .*last event/);
  assert.doesNotMatch(display(), /Private tool result/);
  assert.equal(s.faux.state.callCount, 0); assert.equal(s.completions().length, 0);
  release.resolve();
  await s.wait(() => display().includes("Generating response (turn 2, attempt 1)"));
  await s.wait(() => s.completions().length === 1 && s.widgets.size === 0);
  assert.match(JSON.stringify(s.completions()), /A synthetic final answer/);
  assert.equal(s.faux.state.callCount, 0); assert.equal(f.faux.state.callCount, 2);
  assert.deepEqual(s.errors, []);
});
