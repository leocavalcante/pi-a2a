import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TaskState, type TaskStatus } from "@a2a-js/sdk";
import { boundedText, textOf } from "./client.ts";

export interface ProgressUpdate {
  phase?: "sending" | "observing" | "reconnecting" | "ready" | "paused";
  status?: TaskStatus;
  artifact?: boolean;
}
type Row = {
  agent: string; taskId?: string; started: number; received?: number;
  phase: NonNullable<ProgressUpdate["phase"]>; message: string;
};
const widget = "pi-a2a-progress";
const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Remote status is untrusted plain text, not terminal commands, Markdown, or model context.
const plain = (text: string) => boundedText(text, 512).text
  .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u206f\ufeff]/g, " ")
  .replace(/\s+/g, " ").trim();
const duration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** Ephemeral, session-local UI only. No model calls, transcript writes, or remote polling. */
export class ProgressDisplay {
  private ctx?: ExtensionContext;
  private rows = new Map<string, Row>();
  private timer?: NodeJS.Timeout;
  private frame = 0;
  constructor(private now = Date.now) {}
  bind(ctx: ExtensionContext): void { this.clear(); if (ctx.mode === "tui") this.ctx = ctx; }
  move(from: string, to: string): void {
    const row = this.rows.get(from);
    this.rows.delete(from);
    if (row && !this.rows.has(to)) this.rows.set(to, row);
  }
  update(key: string, agent: string, taskId: string | undefined, update: ProgressUpdate): void {
    if (!this.ctx) return;
    const now = this.now(), old = this.rows.get(key);
    const row: Row = { agent, taskId, started: old?.started ?? now, received: old?.received,
      phase: update.phase ?? "observing", message: old?.message ?? "Waiting for status" };
    if (update.status) {
      row.received = now;
      row.message = update.status.state === TaskState.TASK_STATE_SUBMITTED ? "Queued" : "Working";
      // Terminal messages may contain the entire final answer; completion has its own renderer.
      if ([TaskState.TASK_STATE_SUBMITTED, TaskState.TASK_STATE_WORKING].includes(update.status.state)) {
        const message = update.status.message ? plain(textOf(update.status.message)) : "";
        if (message) row.message = message;
      }
    }
    if (update.artifact) { row.received = now; row.message = "Receiving result"; }
    this.rows.set(key, row);
    if (!this.timer) this.timer = setInterval(() => { this.frame++; this.render(); }, 200).unref();
    this.render();
  }
  remove(key: string): void {
    if (!this.rows.delete(key)) return;
    if (!this.rows.size && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.render();
  }
  clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.rows.clear();
    try { this.ctx?.ui.setWidget(widget, undefined); } catch { /* The UI may already be closed. */ }
    this.ctx = undefined;
  }
  private render(): void {
    try { this.renderWidget(); } catch { /* Display failure must not interrupt remote work or observation. */ }
  }
  private renderWidget(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.rows.size) { ctx.ui.setWidget(widget, undefined); return; }
    const theme = ctx.ui.theme, now = this.now();
    const lines = [theme.fg("muted", theme.bold("A2A"))];
    for (const row of [...this.rows.values()].slice(0, 5)) {
      const paused = row.phase === "paused", ready = row.phase === "ready";
      const icon = paused ? "!" : ready ? "✓" : frames[this.frame % frames.length];
      const message = row.phase === "sending" ? "Sending request" : paused ? "Observation paused; remote work may continue"
        : ready ? "Response ready; waiting for Pi" : row.phase === "reconnecting" ? `Reconnecting; last status: ${row.message}` : row.message;
      const identity = row.agent + (row.taskId ? ` [${Array.from(plain(row.taskId)).slice(0, 8).join("")}]` : "");
      lines.push(theme.fg(paused ? "warning" : ready ? "success" : "accent", `${icon} ${identity}`) + " · " + theme.fg("muted", message));
      const last = row.received === undefined ? "no remote update yet" : `last event ${duration(now - row.received)} ago`;
      lines.push(theme.fg("dim", `  watching ${duration(now - row.started)} · ${last}`));
    }
    if (this.rows.size > 5) lines.push(theme.fg("dim", `  +${this.rows.size - 5} more tasks`));
    // Pi's built-in text widget handles wrapping and terminal widths; use the active theme each render.
    ctx.ui.setWidget(widget, lines);
  }
}
