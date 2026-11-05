import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Message, SendMessageRequest, TaskState, type Task, type StreamResponse } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory, type Client } from "@a2a-js/sdk/client";

export type { Client } from "@a2a-js/sdk/client";
export { TaskState, taskStateToJSON, AgentCard, Message, Task } from "@a2a-js/sdk";

export interface ConnectionOptions {
  /** Credentials stay in this callback, never in model-visible arguments. */
  headers?: () => HeadersInit | Promise<HeadersInit>;
  /** Explicitly trusted origins; Agent Cards cannot authorize extra origins. */
  allowedOrigins?: string[];
  allowHttpLoopback?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

const localErrors = {
  INVALID_ENDPOINT: "Configure a credential-free HTTPS URL, or explicitly allow loopback HTTP for local use.",
  INVALID_CONFIGURATION: "Invalid A2A configuration. Check the configured targets and positive timeout values.",
  CONFIGURATION_UNREADABLE: "Cannot read A2A configuration; use a JSON file of at most 64 KiB.",
  AGENT_NOT_CONFIGURED: "This agent is not explicitly configured. Use a2a_agents and check the machine-local target file.",
  CREDENTIAL_MISSING: "The configured A2A credential file or environment variable is missing or invalid. Supply it outside the session transcript.",
  AUTHENTICATION_FAILED: "The configured A2A peer rejected authentication or access. Check its private credential reference and permissions.",
  UNTRUSTED_ORIGIN: "The Agent Card selected an origin that is not configured as trusted.",
  RESPONSE_TOO_LARGE: "A2A response exceeds the 2 MiB document limit. Request less history or a smaller result.",
} as const;
export class LocalA2AError extends Error {
  constructor(readonly code: keyof typeof localErrors) { super(localErrors[code]); }
}

export function endpoint(value: string, allowHttpLoopback = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new LocalA2AError("INVALID_ENDPOINT"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback && allowHttpLoopback))) {
    throw new LocalA2AError("INVALID_ENDPOINT");
  }
  return url;
}

/** Native official-SDK client. No Pi or Durable dependency is loaded here. */
export async function connectAgent(baseUrl: string, options: ConnectionOptions = {}): Promise<Client> {
  const base = endpoint(baseUrl, options.allowHttpLoopback);
  const origins = new Set([base.origin, ...(options.allowedOrigins ?? []).map(url => endpoint(url, options.allowHttpLoopback).origin)]);
  const timeoutMs = options.timeoutMs ?? 330_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new LocalA2AError("INVALID_CONFIGURATION");
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!origins.has(url.origin) || url.username || url.password) throw new LocalA2AError("UNTRUSTED_ORIGIN");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [key, value] of new Headers(await options.headers?.())) headers.set(key, value);
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
    const response = await (options.fetch ?? globalThis.fetch)(input, { ...init, headers, signal, redirect: "error" });
    if (response.status === 401 || response.status === 403) {
      try { await response.body?.cancel(); } catch { /* Preserve the authentication outcome even if body cleanup fails. */ }
      throw new LocalA2AError("AUTHENTICATION_FAILED");
    }
    // Streaming events have the SDK's per-event byte limit. Bound complete JSON documents too.
    if (response.headers.get("content-type")?.includes("text/event-stream")) return response;
    if (!response.body || response.status === 204 || response.status === 304) return response;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new LocalA2AError("RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: guardedFetch }), new RestTransportFactory({ fetchImpl: guardedFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: guardedFetch }),
  });
  return factory.createFromUrl(base.href);
}

export interface TextMessageOptions {
  messageId: string;
  contextId?: string;
  taskId?: string;
  returnImmediately?: boolean;
  signal?: AbortSignal;
}

export function textRequest(text: string, options: TextMessageOptions): SendMessageRequest {
  if (!text.trim() || Buffer.byteLength(text) > 8192) throw new Error("Text must contain 1–8192 UTF-8 bytes.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.messageId)) throw new Error("Supply a stable messageId of 1–128 ASCII ID characters.");
  return SendMessageRequest.fromJSON({
    message: { messageId: options.messageId, contextId: options.contextId, taskId: options.taskId, role: "ROLE_USER", parts: [{ text, mediaType: "text/plain" }] },
    configuration: { returnImmediately: options.returnImmediately ?? true },
  });
}

/** Allocate and retain the ID BEFORE calling sendText; an uncertain send is not safe to retry with a new ID. */
export const newMessageId = () => randomUUID();
export function sendText(client: Client, text: string, options: TextMessageOptions) {
  return client.sendMessage(textRequest(text, options), { signal: options.signal });
}
export function streamText(client: Client, text: string, options: TextMessageOptions): AsyncGenerator<StreamResponse, void, undefined> {
  return client.sendMessageStream(textRequest(text, options), { signal: options.signal });
}
export function isTask(value: Message | Task): value is Task { return "id" in value; }
export function terminal(task: Task): boolean {
  return [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(task.status?.state ?? 0);
}
export function interrupted(task: Task): boolean {
  return [TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED].includes(task.status?.state ?? 0);
}
export function textOf(value: Message | Task): string {
  const artifacts = isTask(value) ? value.artifacts.flatMap(item => item.parts) : [];
  const parts = isTask(value) ? artifacts.length ? artifacts : value.status?.message?.parts ?? [] : value.parts;
  return parts.flatMap(part => part.content?.$case === "text" ? [part.content.value] : []).join("\n");
}
/** Bound both UTF-8 and JSON-rendered text without splitting Unicode characters. */
export function boundedText(value: string, maxBytes = 32_768): { text: string; truncated: boolean } {
  let bytes = 2, text = "";
  for (const point of value) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (bytes + size > maxBytes) break;
    bytes += size; text += point;
  }
  return { text, truncated: text.length !== value.length };
}
/** Aborting this wait never calls CancelTask and never cancels admitted work. */
export async function waitForTask(client: Client, id: string, options: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (task: Task) => void } = {}): Promise<Task> {
  for (;;) {
    const task = await client.getTask({ id, tenant: "", historyLength: 0 }, { signal: options.signal });
    options.onUpdate?.(task);
    if (terminal(task) || interrupted(task)) return task;
    await delay(options.intervalMs ?? 500, undefined, { signal: options.signal });
  }
}
export function taskFromEvent(event: StreamResponse): Task | undefined { return event.payload?.$case === "task" ? event.payload.value : undefined; }

/** Remote diagnostics may contain credentials or provider payloads. Do not forward their text. */
export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof LocalA2AError) return { code: error.code, message: error.message };
  const allowed = ["TASK_NOT_FOUND", "TASK_NOT_CANCELABLE", "PUSH_NOTIFICATION_NOT_SUPPORTED", "UNSUPPORTED_OPERATION", "CONTENT_TYPE_NOT_SUPPORTED", "INVALID_AGENT_RESPONSE", "VERSION_NOT_SUPPORTED", "REQUEST_MALFORMED"];
  const reason = typeof error === "object" && error !== null && "reason" in error ? String(error.reason) : "";
  const code = allowed.includes(reason) ? reason : error instanceof Error && error.name === "AbortError" ? "WAIT_ABORTED" : "A2A_REQUEST_FAILED";
  return { code, message: "A2A request did not complete. Inspect the original message/task ID before retrying; local interruption does not cancel remote work." };
}
