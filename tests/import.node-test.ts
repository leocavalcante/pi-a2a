import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isTask, sendText, textOf, TaskState } from "../src/client.ts";
import { context, fixture } from "./fixtures/agent.ts";
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

test("an existing submission becomes an A2A task without submitting or running it again", async t => {
  const f = await fixture({ answers: ["Retained answer"] }); t.after(f.close);
  const original = await f.root.submit({ type: "input", content: "Original text", requestId: "historic-id" }, context);
  await original.wait(context);
  f.adapter.options.existingSubmission = async id => id === "historic-id" ? { submissionId: original.id, textSha256: digest("Original text") } : undefined;
  const task = await f.client.getTask({ id: "historic-id", tenant: "" });
  assert.equal(task.id, "historic-id"); assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(textOf(task), "Retained answer");
  const replay = await sendText(f.client, "Original text", { messageId: "historic-id" });
  assert.ok(isTask(replay)); assert.equal(replay.id, task.id);
  await assert.rejects(sendText(f.client, "Changed", { messageId: "historic-id" }), /already belongs/);
  assert.equal(f.faux.state.callCount, 1);
});

test("first contact may be an identical legacy message replay; imported bindings survive SQLite reopen", async t => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-import-")); t.after(() => rm(dir, { recursive: true }));
  const db = join(dir, "session.sqlite");
  const f = await fixture({ storage: await openNodeSqliteStorage(db), answers: ["Old result"] }); t.after(f.close);
  const original = await f.root.submit({ type: "input", content: "Literal R$800\n$(untouched)", requestId: "old-message" }, context);
  await original.wait(context);
  f.adapter.options.existingSubmission = async id => id === "old-message" ? { submissionId: original.id, textSha256: digest("Literal R$800\n$(untouched)") } : undefined;
  const replay = await sendText(f.client, "Literal R$800\n$(untouched)", { messageId: "old-message" });
  assert.ok(isTask(replay)); assert.equal(replay.id, "old-message");
  await f.close();
  const reopened = await fixture({ storage: await openNodeSqliteStorage(db), answers: [] });
  try {
    const task = await reopened.client.getTask({ id: "old-message", tenant: "" });
    assert.equal(textOf(task), "Old result");
    const repeated = await sendText(reopened.client, "Literal R$800\n$(untouched)", { messageId: "old-message" });
    assert.ok(isTask(repeated)); assert.equal(repeated.id, task.id);
    await assert.rejects(sendText(reopened.client, "Other", { messageId: "old-message" }), /already belongs/);
    assert.equal(reopened.faux.state.callCount, 0);
  } finally { await reopened.close(); }
});

test("existing-submission imports reject missing or foreign-conversation submissions", async t => {
  const f = await fixture(); t.after(f.close);
  const other = await f.harness.createConversation({ ownership: { kind: "ownerless" } }, context);
  const submission = await other.submit({ type: "input", content: "Private to another conversation", requestId: "foreign" }, context);
  f.adapter.options.existingSubmission = async () => ({ submissionId: submission.id, textSha256: digest("Private to another conversation") });
  await assert.rejects(f.client.getTask({ id: "foreign", tenant: "" }), /conversation/);
  assert.equal((await f.client.listTasks({ tenant: "", contextId: "", status: 0, pageToken: "", statusTimestampAfter: undefined })).tasks.length, 0);
});
