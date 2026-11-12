import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { isTask, sendText, textOf, TaskState, waitForTask } from "../src/client.ts";
import { createA2ATools } from "../src/durable.ts";
import { context, fixture } from "./fixtures/agent.ts";

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
