import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isTask, sendText, textOf, waitForTask } from "../src/client.ts";
import { context, fixture } from "./fixtures/agent.ts";
import { deferred, mesh } from "./fixtures/mesh.ts";

const lastReply = (input: TranscriptContext) => {
  const message = input.messages.findLast(value => value.role === "toolResult");
  assert.ok(message?.role === "toolResult");
  return JSON.parse(message.content.filter(value => value.type === "text").map(value => value.text).join("\n"));
};
async function admitted(m: Awaited<ReturnType<typeof mesh>>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const live = await m.alpha.harness.snapshot(LiveDoc, m.alpha.root.id, context);
    const details = live?.tools?.find(tool => tool.name === "a2a_send")?.details;
    if (details && typeof details === "object" && !Array.isArray(details) && typeof details.taskId === "string") return details.taskId;
    await delay(10);
  }
  throw new Error("No durable peer acknowledgement before the synthetic deadline.");
}

for (const retarget of [false, true]) test(`a saved delegation ${retarget ? "refuses a retargeted alias" : "resumes observation"} after owner replacement without resending`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-peer-recovery-")), database = join(directory, "source.sqlite");
  const release = deferred();
  const m = await mesh({ sourceStorage: await openNodeSqliteStorage(database) });
  t.after(async () => { release.resolve(); await m.close(); await rm(directory, { recursive: true, force: true }); });
  m.beta.faux.setResponses([async () => { await release.promise; return fauxAssistantMessage("Retained peer result."); }]);
  m.alpha.faux.setResponses([fauxAssistantMessage(fauxToolCall("a2a_send", { agent: "beta", message: "Synthetic retained request" }), { stopReason: "toolUse" })]);
  const parent = await sendText(m.alpha.client, "Delegate the synthetic unit", { messageId: "retained-parent" }); assert.ok(isTask(parent));
  const childId = await admitted(m), rootId = m.alpha.root.id;
  await m.alpha.close();
  let gamma: Awaited<ReturnType<typeof fixture>> | undefined;
  if (retarget) {
    gamma = await fixture({ answers: [] }); t.after(gamma.close);
    m.configs.alpha.agents.beta.url = gamma.baseUrl;
  }
  const source = await m.reopenSource(() => openNodeSqliteStorage(database), [retarget ? "Original delegation retained; changed endpoint not contacted." : "Recovered delegated result."]);
  release.resolve();
  const settled = await waitForTask(source.client, parent.id, { intervalMs: 10 });
  assert.equal(source.root.id, rootId); assert.equal(settled.id, parent.id); assert.equal(settled.contextId, parent.contextId);
  const entries = await source.root.entries({}, 100, undefined, context);
  const reply = lastReply({ messages: entries.items.flatMap(entry => entry.model ?? []) } as TranscriptContext);
  assert.equal(reply.taskId, childId);
  if (retarget) assert.equal(reply.error.code, "TARGET_CHANGED");
  else { assert.equal(reply.state, "TASK_STATE_COMPLETED"); assert.equal(reply.text, "Retained peer result."); }
  assert.match(textOf(settled), retarget ? /changed endpoint not contacted/ : /Recovered delegated result/);
  assert.equal(m.beta.faux.state.callCount, 1); assert.equal(source.faux.state.callCount, 1);
  if (gamma) assert.equal(gamma.faux.state.callCount, 0);
  assert.deepEqual(source.reports, []);
});

for (const retarget of [false, true]) test(`a lost acknowledgement stays uncertain after replacement${retarget ? " and endpoint retargeting" : ""}, without resubmission`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-peer-uncertain-")), database = join(directory, "source.sqlite");
  const release = deferred(), accepted = deferred();
  const m = await mesh({ sourceStorage: await openNodeSqliteStorage(database) });
  t.after(async () => { release.resolve(); await m.close(); await rm(directory, { recursive: true, force: true }); });
  m.beta.faux.setResponses([async () => { await release.promise; return fauxAssistantMessage("Peer work completed once."); }]);
  m.alpha.faux.setResponses([fauxAssistantMessage(fauxToolCall("a2a_send", { agent: "beta", message: "Synthetic uncertain request" }), { stopReason: "toolUse" })]);
  let sends = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (String(input) === `${m.beta.baseUrl}/a2a` && typeof init?.body === "string" && JSON.parse(init.body).method === "SendMessage") {
      sends++; assert.equal(response.status, 200); accepted.resolve();
      assert.ok(init.signal);
      await new Promise<void>((_resolve, reject) => {
        if (init.signal!.aborted) reject(new DOMException("Synthetic lost receipt", "AbortError"));
        else init.signal!.addEventListener("abort", () => reject(new DOMException("Synthetic lost receipt", "AbortError")), { once: true });
      });
    }
    return response;
  });
  const parent = await sendText(m.alpha.client, "Delegate uncertain synthetic work", { messageId: "uncertain-parent" }); assert.ok(isTask(parent));
  await accepted.promise;
  await m.alpha.close();
  let gamma: Awaited<ReturnType<typeof fixture>> | undefined;
  if (retarget) {
    gamma = await fixture({ answers: [] }); t.after(gamma.close);
    m.configs.alpha.agents.beta.url = gamma.baseUrl;
  }
  const source = await m.reopenSource(() => openNodeSqliteStorage(database), ["Delivery is uncertain; no new send was made."]);
  release.resolve();
  const result = await waitForTask(source.client, parent.id, { intervalMs: 10 });
  const entries = await source.root.entries({}, 100, undefined, context);
  const reply = lastReply({ messages: entries.items.flatMap(entry => entry.model ?? []) } as TranscriptContext);
  assert.equal(reply.error.code, retarget ? "TARGET_CHANGED" : "DELIVERY_UNCERTAIN"); assert.equal(reply.uncertain, true); assert.ok(reply.messageId);
  assert.match(textOf(result), /no new send/); assert.equal(sends, 1); assert.equal(m.beta.faux.state.callCount, 1);
  if (gamma) assert.equal(gamma.faux.state.callCount, 0);
  assert.deepEqual(source.reports, []);
});
