import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { connectAgent, isTask, sendText, textOf, TaskState, waitForTask } from "../src/client.ts";
import { createA2ATools } from "../src/durable.ts";
import { context, fixture } from "./fixtures/agent.ts";

test("SIGKILL recovery preserves the admitted task and message-ID binding", async t => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-kill-"));
  const db = join(dir, "agent.sqlite");
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/crash.ts", import.meta.url)), db], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (reopened) await reopened.close();
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    await rm(dir, { recursive: true });
  });
  let text = ""; child.stdout.on("data", chunk => { text += String(chunk); if (text.length > 16_384) child.kill("SIGKILL"); });
  child.stderr.on("data", () => {}); // Only synthetic fixture diagnostics; do not leave a full child pipe blocked.
  const waitEvent = async (event: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const line of text.split("\n")) {
        try { const value = JSON.parse(line); if (value.event === event) return value; } catch { /* Partial line. */ }
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Fixture ended before its checkpoint.");
      await delay(10);
    }
    throw new Error("Fixture did not reach its checkpoint before the deadline.");
  };
  const ready = await waitEvent("ready");
  const client = await connectAgent(ready.url, { allowHttpLoopback: true });
  const admitted = await sendText(client, "Crash recovery", { messageId: "killed-request" }); assert.ok(isTask(admitted));
  await waitEvent("model_started");
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  reopened = await fixture({ storage: await openNodeSqliteStorage(db), retries: 1, answers: ["Recovered after SIGKILL"] });
  const result = await waitForTask(reopened.client, admitted.id, { intervalMs: 10 });
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(result.contextId, admitted.contextId); assert.equal(textOf(result), "Recovered after SIGKILL");
  const retried = await sendText(reopened.client, "Crash recovery", { messageId: "killed-request" }); assert.ok(isTask(retried));
  assert.equal(retried.id, admitted.id); assert.equal(reopened.faux.state.callCount, 1);
});

test("one Durable agent can delegate to another through the public outbound tools", async t => {
  const target = await fixture({ answers: ["Delegated reply"] }); t.after(target.close);
  const registry = createRegistry();
  registry.install(createA2ATools({ config: async () => ({ agents: { destination: { url: target.baseUrl, allowHttpLoopback: true } } }) }));
  const source = await fixture({ registry }); t.after(source.close);
  source.faux.setResponses([
    fauxAssistantMessage([fauxToolCall("a2a_send", { agent: "destination", message: "Synthetic delegation", messageId: "durable-to-durable" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("Delegation finished")]),
  ]);
  const submitted = await sendText(source.client, "Delegate", { messageId: "source-request" }); assert.ok(isTask(submitted));
  const result = await waitForTask(source.client, submitted.id, { intervalMs: 10 });
  assert.equal(textOf(result), "Delegation finished");
  const entries = await source.root.entries({}, 100, undefined, context);
  const replies = entries.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult");
  assert.equal(replies.length, 1);
  const reply = replies[0]; assert.equal(reply.role, "toolResult");
  if (reply.role === "toolResult") { assert.equal(reply.isError, false); assert.match(JSON.stringify(reply.content), /Delegated reply/); }
  assert.equal(target.faux.state.callCount, 1); assert.equal(source.faux.state.callCount, 2);
  assert.ok(!source.reports.includes("extension_error"));
});

test("unanswered submissions become failed tasks without forwarding provider diagnostics", async t => {
  const f = await fixture({ answers: [] }); t.after(f.close);
  const value = await sendText(f.client, "No scripted reply", { messageId: "failure-case" }); assert.ok(isTask(value));
  const task = await waitForTask(f.client, value.id, { intervalMs: 10 });
  assert.equal(task.status?.state, TaskState.TASK_STATE_FAILED);
  assert.ok(!JSON.stringify(task).includes("No more faux responses"));
});

test("commentary-only output is not reported as a completed text answer", async t => {
  const f = await fixture(); t.after(f.close);
  f.faux.setResponses([fauxAssistantMessage([{ ...fauxText("Only commentary"), textSignature: JSON.stringify({ phase: "commentary" }) }])]);
  const value = await sendText(f.client, "Need a final answer", { messageId: "no-final" }); assert.ok(isTask(value));
  const task = await waitForTask(f.client, value.id, { intervalMs: 10 });
  assert.equal(task.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(task.artifacts.length, 0);
});
