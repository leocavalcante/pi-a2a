import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import { defineDocFamily, type Harness, type Tx } from "@earendil-works/pi-durable";
import { Task, TaskPushNotificationConfig, StreamResponse, TaskState, type ListTaskPushNotificationConfigsResponse } from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";

export interface PushOptions {
  /** Exact application-approved callback origins. No discovery or wildcard trust. */
  allowedOrigins: string[];
  /** Explicit test/development exception only. */
  allowHttpLoopback?: boolean;
}
type Saved = { scope: string; taskId: string; config: { [key: string]: JsonValue }; delivered: string;
  pending: string; body: string; attempts: number; next: number };
const Registry = defineDocFamily<{ items: Record<string, Saved> }, null>({
  kind: "pi-a2a.push", version: 1, scope: "session", family: true, initial: () => ({ items: {} }), checkpointWhen: () => true,
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new RequestMalformedError("Invalid push configuration identity.");
};

/** Private durable metadata only. Callback credentials never enter model entries or task projections. */
export class DurablePush {
  private readonly abort = new AbortController();
  private loop?: Promise<void>;
  private flight?: Promise<void>;
  constructor(private readonly harness: Harness, private readonly context: Context, private readonly options: PushOptions,
    private readonly task: (taskId: string, scope: string) => Promise<Task>) {
    if (!options.allowedOrigins.length) throw new Error("Push callbacks require an explicit origin allowlist.");
    for (const origin of options.allowedOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin) throw new Error("Configure exact push origins, without a path.");
      this.url(origin);
    }
  }
  private url(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new RequestMalformedError("Invalid push URL."); }
    const local = this.options.allowHttpLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || !this.options.allowedOrigins.includes(url.origin) || url.username || url.password || url.search || url.hash)
      throw new RequestMalformedError("Push URL is outside the explicitly trusted callback origin.");
    return url;
  }
  validate(config: TaskPushNotificationConfig): TaskPushNotificationConfig {
    const value = TaskPushNotificationConfig.fromJSON(TaskPushNotificationConfig.toJSON(config));
    value.id ||= randomUUID(); id(value.id);
    this.url(value.url);
    if (value.token || value.authentication?.scheme.toLowerCase() !== "bearer" ||
        !/^[A-Za-z0-9._~+/-]{16,16300}=*$/.test(value.authentication?.credentials ?? ""))
      throw new RequestMalformedError("Use bounded bearer authentication for the push callback.");
    return value;
  }
  async put(scope: string, config: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> {
    const value = this.validate(config); id(value.taskId);
    await this.task(value.taskId, scope);
    await this.harness.commit(tx => this.bind(tx, scope, value), this.context);
    return value;
  }
  async bind(tx: Tx, scope: string, value: TaskPushNotificationConfig): Promise<void> {
    const key = hash([scope, value.taskId, value.id]);
    const registry = await tx.doc(Registry, "callbacks", null);
    if (!registry.items[key] && Object.keys(registry.items).length >= 2048) throw new RequestMalformedError("Push configuration limit reached; remove finished task configurations.");
    const previous = registry.items[key];
    const json = clone(TaskPushNotificationConfig.toJSON(value)) as { [key: string]: JsonValue };
    if (previous && hash(previous.config) === hash(json)) return;
    registry.items[key] = { scope, taskId: value.taskId, config: json, delivered: "", pending: "", body: "", attempts: 0, next: 0 };
  }
  async get(scope: string, taskId: string, configId: string): Promise<TaskPushNotificationConfig> {
    id(taskId); id(configId); await this.task(taskId, scope);
    const registry = await this.harness.snapshot(Registry, "callbacks", this.context);
    const saved = registry?.items[hash([scope, taskId, configId])];
    if (!saved) throw new TaskNotFoundError();
    return TaskPushNotificationConfig.fromJSON(clone(saved.config));
  }
  async list(scope: string, taskId: string, pageSize = 50, pageToken = ""): Promise<ListTaskPushNotificationConfigsResponse> {
    id(taskId); await this.task(taskId, scope);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RequestMalformedError("Invalid push configuration page size.");
    const registry = await this.harness.snapshot(Registry, "callbacks", this.context);
    const values = Object.values(registry?.items ?? {}).filter(value => value.scope === scope && value.taskId === taskId)
      .map(value => TaskPushNotificationConfig.fromJSON(clone(value.config))).sort((a, b) => a.id.localeCompare(b.id));
    let after = "";
    if (pageToken) {
      try {
        const cursor = JSON.parse(Buffer.from(pageToken, "base64url").toString());
        if (pageToken.length > 1024 || cursor.scope !== scope || cursor.taskId !== taskId || typeof cursor.after !== "string") throw new Error();
        after = cursor.after;
      } catch { throw new RequestMalformedError("Invalid push configuration cursor."); }
    }
    const remaining = values.filter(value => value.id > after), configs = remaining.slice(0, pageSize);
    return { configs, nextPageToken: remaining.length > pageSize ? Buffer.from(JSON.stringify({ scope, taskId, after: configs.at(-1)!.id })).toString("base64url") : "" };
  }
  async delete(scope: string, taskId: string, configId: string): Promise<void> {
    id(taskId); id(configId); await this.task(taskId, scope);
    await this.harness.commit(async tx => { delete (await tx.doc(Registry, "callbacks", null)).items[hash([scope, taskId, configId])]; }, this.context);
  }
  start(): void {
    if (this.loop || this.abort.signal.aborted) return;
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        try { await this.flush(); } catch { /* A stopped/failed Harness is handled by its application owner. */ }
        try { await delay(1000, undefined, { signal: this.abort.signal, ref: false }); } catch { break; }
      }
    })();
  }
  async close(): Promise<void> { this.abort.abort(); await this.loop; await this.flight; }
  flush(): Promise<void> {
    if (!this.flight) this.flight = this.deliver().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async deliver(): Promise<void> {
    const snapshot = await this.harness.snapshot(Registry, "callbacks", this.context);
    if (!snapshot) return;
    const registry = clone(snapshot);
    for (const [key, saved] of Object.entries(registry.items)) {
      if (this.abort.signal.aborted || saved.next > Date.now()) continue;
      const task = await this.task(saved.taskId, saved.scope);
      if (![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED,
        TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? 0)) continue;
      const revision = hash([task.id, task.contextId, task.status]);
      if (saved.delivered === revision && !saved.pending) continue;
      // Persist intent before the external effect; retry uses the identical body.
      const body = saved.pending ? saved.body : JSON.stringify(StreamResponse.toJSON({ payload: { $case: "task", value: { ...task, history: [] } } }));
      const pending = saved.pending || revision;
      await this.harness.commit(async tx => {
        const current = (await tx.doc(Registry, "callbacks", null)).items[key];
        if (current && hash(current.config) === hash(saved.config)) { current.pending = pending; current.body = body; }
      }, this.context);
      const latest = (await this.harness.snapshot(Registry, "callbacks", this.context))?.items[key];
      if (!latest || latest.pending !== pending || hash(latest.config) !== hash(saved.config)) continue;
      let delivered = false;
      try {
        const config = this.validate(TaskPushNotificationConfig.fromJSON(clone(saved.config)));
        const response = await fetch(config.url, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/a2a+json", "A2A-Version": "1.0", Authorization: `Bearer ${config.authentication!.credentials}` },
          body, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]) });
        delivered = response.ok;
        await response.body?.cancel();
      } catch { /* Do not retain or log callback URLs, credentials, bodies or network diagnostics. */ }
      await this.harness.commit(async tx => {
        const current = (await tx.doc(Registry, "callbacks", null)).items[key];
        if (!current || current.pending !== pending || hash(current.config) !== hash(saved.config)) return;
        if (delivered) { current.delivered = pending; current.pending = ""; current.body = ""; current.attempts = 0; current.next = 0; }
        else { current.attempts++; current.next = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(current.attempts - 1, 6)); }
      }, this.context);
    }
  }
}
