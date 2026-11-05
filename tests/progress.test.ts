import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Message, TaskState, type TaskStatus } from "@a2a-js/sdk";
import { ProgressDisplay } from "../src/progress.ts";
import { changedUntil } from "./fixtures/completion.ts";

function display(mode: ExtensionContext["mode"] = "tui") {
  let now = 0, palette = "", calls = 0;
  let lines: string[] | undefined;
  const events = new EventEmitter();
  const ctx = { mode, ui: {
    theme: { fg: (_color: string, text: string) => palette + text, bold: (text: string) => text },
    setWidget: (_key: string, content: string[] | undefined) => { lines = content; calls++; events.emit("change"); },
  } } as unknown as ExtensionContext;
  const ui = new ProgressDisplay(() => now); ui.bind(ctx);
  return { ui, ctx, events, text: () => lines?.join("\n") ?? "", calls: () => calls,
    clock: (value: number) => { now = value; }, palette: (value: string) => { palette = value; } };
}
function status(text: string, state = TaskState.TASK_STATE_WORKING): TaskStatus {
  return { state, timestamp: undefined, message: Message.fromJSON({ messageId: "synthetic-progress", role: "ROLE_AGENT", parts: [{ text }] }) };
}

test("progress retains elapsed watching time across admission, animates, and ages only received events", async t => {
  const h = display(); t.after(() => h.ui.clear());
  h.ui.update("intent", "dj", undefined, { phase: "sending" });
  assert.match(h.text(), /Sending request/); assert.match(h.text(), /no remote update yet/);
  h.clock(1000); h.ui.move("intent", "task");
  h.ui.update("task", "dj", "task-123456789", { status: status("Generating response") });
  assert.match(h.text(), /dj \[task-123\]/);
  assert.match(h.text(), /watching 1s · last event 0s ago/);
  const original = h.text();
  h.clock(61_000);
  await changedUntil(h.events, () => h.text().includes("watching 1m 1s · last event 1m 0s ago"));
  assert.notEqual(h.text(), original);
  h.ui.update("task", "dj", "task-123456789", { phase: "reconnecting" });
  assert.match(h.text(), /Reconnecting; last status: Generating response/);
  assert.match(h.text(), /last event 1m 0s ago/);
  h.ui.update("task", "dj", "task-123456789", { status: status("Running tools (1/2 complete)") });
  assert.match(h.text(), /Running tools \(1\/2 complete\)/); assert.match(h.text(), /last event 0s ago/);
});

test("remote statuses and IDs are bounded, single-line, terminal-safe text; final answers stay out of progress", t => {
  const h = display(); t.after(() => h.ui.clear());
  h.ui.update("task", "dj", "\u001b]52;c;synthetic\u0007", { status: status("\u001b[2J\u009b\u202e\n" + "😀".repeat(2000)) });
  assert.doesNotMatch(h.text(), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
  assert.ok(Buffer.byteLength(h.text()) < 900); assert.ok(!h.text().includes("\ufffd"));
  assert.equal(h.text().split("\n").length, 3);
  h.ui.update("task", "dj", "task", { status: status("Synthetic final answer must not become a status", TaskState.TASK_STATE_COMPLETED) });
  assert.doesNotMatch(h.text(), /Synthetic final answer/);
  h.ui.update("task", "dj", "task", { phase: "ready" });
  assert.match(h.text(), /✓ dj/); assert.match(h.text(), /Response ready; waiting for Pi/);
});

test("concurrent tasks have independent rows, bounded height, and honest paused/ready states", t => {
  const h = display(); t.after(() => h.ui.clear());
  for (let i = 0; i < 7; i++) h.ui.update(`key-${i}`, "dj", `task-${i}`, { status: status(`Stage ${i}`) });
  assert.match(h.text(), /\+2 more tasks/); assert.equal(h.text().split("\n").length, 12);
  h.ui.update("key-0", "dj", "task-0", { phase: "paused" });
  h.ui.update("key-1", "dj", "task-1", { phase: "ready" });
  assert.match(h.text(), /! dj \[task-0\].*Observation paused; remote work may continue/);
  assert.match(h.text(), /✓ dj \[task-1\].*Response ready; waiting for Pi/);
  h.ui.remove("key-0"); assert.doesNotMatch(h.text(), /task-0/); assert.match(h.text(), /task-1/);
  for (let i = 1; i < 7; i++) h.ui.remove(`key-${i}`);
  assert.equal(h.text(), "");
});

test("theme changes apply on the next frame, and shutdown clears widgets and timers", async () => {
  const h = display();
  try {
    h.ui.update("task", "dj", "task", { status: status("Working") });
    h.palette("new-theme:");
    await changedUntil(h.events, () => h.text().includes("new-theme:"));
    h.ui.clear(); const calls = h.calls();
    await delay(250);
    assert.equal(h.text(), ""); assert.equal(h.calls(), calls);
  } finally { h.ui.clear(); }
});

test("print, JSON and RPC never start a terminal widget", () => {
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = display(mode);
    h.ui.update("task", "dj", "task", { status: status("Working") });
    h.ui.clear(); assert.equal(h.calls(), 0);
  }
});

test("UI failures do not interrupt request handling, observation, or cleanup", () => {
  const h = display();
  h.ctx.ui.setWidget = () => { throw new Error("Synthetic closed UI"); };
  assert.doesNotThrow(() => {
    h.ui.update("task", "dj", "task", { status: status("Working") });
    h.ui.remove("task"); h.ui.clear();
  });
});
