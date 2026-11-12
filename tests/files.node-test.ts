import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifact } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isTask, sendText, waitForTask } from "../src/client.ts";
import { fixture } from "./fixtures/agent.ts";

const sha = "1".repeat(64);
const file = (origin: string, id: string) => Artifact.fromJSON({ artifactId: `media-${sha}`, name: "image.png",
  parts: [{ url: `${origin}/media/tasks/${id}/${sha}`, filename: "image.png", mediaType: "image/png", metadata: { sha256: sha, bytes: 12 } }] });

test("host URL artifacts enrich retained completed tasks without rerunning or changing the committed answer", async t => {
  const directory = await mkdtemp(join(tmpdir(), "a2a-files-")); t.after(() => rm(directory, { recursive: true }));
  const database = join(directory, "agent.sqlite");
  let origin = "", visible = false;
  const f = await fixture({ storage: await openNodeSqliteStorage(database), fileArtifacts: async task => visible ? [file(origin, task.id)] : [] }); t.after(f.close);
  origin = f.baseUrl;
  const accepted = await sendText(f.client, "Synthetic retained output", { messageId: "existing-output" }); assert.ok(isTask(accepted));
  const admitted = await waitForTask(f.client, accepted.id, { intervalMs: 10 });
  const stamp = admitted.status?.timestamp;
  assert.equal(admitted.artifacts.length, 1);
  visible = true;
  const enriched = await f.client.getTask({ id: admitted.id, tenant: "", historyLength: 0 });
  assert.equal(enriched.artifacts.length, 2); assert.equal(enriched.status?.timestamp, stamp);
  assert.deepEqual(enriched.artifacts[0], admitted.artifacts[0]); assert.equal(f.faux.state.callCount, 1);
  assert.equal(enriched.artifacts[1].parts[0].content?.$case, "url");
  await f.close();
  const reopened = await fixture({ storage: await openNodeSqliteStorage(database), answers: [], fileArtifacts: async task => [file(origin, task.id)] }); t.after(reopened.close);
  origin = reopened.baseUrl;
  const retained = await reopened.client.getTask({ id: admitted.id, tenant: "", historyLength: 0 });
  assert.equal(retained.artifacts.length, 2); assert.equal(retained.status?.timestamp, stamp); assert.equal(reopened.faux.state.callCount, 0);
});

test("file projection runs only after the authenticated task scope is checked", async t => {
  let origin = "", calls = 0;
  const f = await fixture({ fileArtifacts: async task => { calls++; return [file(origin, task.id)]; } }); t.after(f.close); origin = f.baseUrl;
  const task = await sendText(f.client, "Synthetic scoped output", { messageId: "scoped-file" }); assert.ok(isTask(task));
  await waitForTask(f.client, task.id, { intervalMs: 10 });
  const before = calls;
  await assert.rejects(f.adapter.getTask({ id: task.id, tenant: "", historyLength: 0 },
    new ServerCallContext({ user: { isAuthenticated: true, userName: "another-owner" } })), /not found/i);
  assert.equal(calls, before);
});

test("host artifacts cannot replace the answer or expose credential-bearing and off-origin URLs", async t => {
  let origin = "", variant = "valid";
  const f = await fixture({ fileArtifacts: async task => {
    const result = file(origin, task.id);
    if (variant === "duplicate") result.artifactId = "answer";
    if (variant === "external") result.parts[0].content = { $case: "url", value: "https://elsewhere.invalid/image.png" };
    if (variant === "query") result.parts[0].content = { $case: "url", value: `${origin}/image.png?private=value` };
    if (variant === "type") result.parts[0].mediaType = "application/octet-stream";
    return [result];
  } }); t.after(f.close); origin = f.baseUrl;
  const task = await sendText(f.client, "Synthetic guarded output", { messageId: "guarded-file" }); assert.ok(isTask(task));
  await waitForTask(f.client, task.id, { intervalMs: 10 });
  for (variant of ["duplicate", "external", "query", "type"]) {
    await assert.rejects(f.client.getTask({ id: task.id, tenant: "", historyLength: 0 }));
  }
  variant = "valid";
  const recovered = await f.client.getTask({ id: task.id, tenant: "", historyLength: 0 });
  assert.equal(recovered.artifacts.length, 2); assert.equal(f.faux.state.callCount, 1);
});
