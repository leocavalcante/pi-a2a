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
import {
  connectAgent,
  isTask,
  sendText,
  textOf,
  TaskState,
  waitForTask,
} from "../src/client.ts";
import { fixture } from "./fixtures/agent.ts";

// Runs on Node.js: SIGKILL recovery depends on Node's child processes and node:sqlite,
// and the fixture child loads TypeScript through jiti, the loader Pi uses.
test("SIGKILL recovery preserves the admitted task and message-ID binding", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-kill-"));
  const db = join(dir, "agent.sqlite");
  // eslint-disable-next-line prefer-const -- Registered cleanup must cover failure before recovery setup finishes.
  let reopened: Awaited<ReturnType<typeof fixture>> | undefined;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "jiti/register",
      fileURLToPath(new URL("./fixtures/crash.ts", import.meta.url)),
      db,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(async () => {
    if (reopened) await reopened.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
    await rm(dir, { recursive: true });
  });
  let text = "";
  child.stdout.on("data", (chunk) => {
    text += String(chunk);
    if (text.length > 16_384) child.kill("SIGKILL");
  });
  // Discard synthetic fixture diagnostics without leaving the child pipe blocked.
  child.stderr.resume();
  const waitEvent = async (event: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      for (const line of text.split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.event === event) return value;
        } catch {
          /* Partial line. */
        }
      }
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error("Fixture ended before its checkpoint.");
      await delay(10);
    }
    throw new Error(
      "Fixture did not reach its checkpoint before the deadline.",
    );
  };
  const ready = await waitEvent("ready");
  const client = await connectAgent(ready.url, { allowHttpLoopback: true });
  const admitted = await sendText(client, "Crash recovery", {
    messageId: "killed-request",
  });
  assert.ok(isTask(admitted));
  await waitEvent("model_started");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  reopened = await fixture({
    storage: await openNodeSqliteStorage(db),
    retries: 1,
    answers: ["Recovered after SIGKILL"],
  });
  const result = await waitForTask(reopened.client, admitted.id, {
    intervalMs: 10,
  });
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(result.contextId, admitted.contextId);
  assert.equal(textOf(result), "Recovered after SIGKILL");
  const retried = await sendText(reopened.client, "Crash recovery", {
    messageId: "killed-request",
  });
  assert.ok(isTask(retried));
  assert.equal(retried.id, admitted.id);
  assert.equal(reopened.faux.state.callCount, 1);
});
