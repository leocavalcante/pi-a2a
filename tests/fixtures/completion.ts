import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { Client, type Transport } from "@a2a-js/sdk/client";
import { AgentCard, Message, StreamResponse, Task, TaskState, type SendMessageRequest } from "@a2a-js/sdk";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import { card } from "./agent.ts";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function changedUntil(events: EventEmitter, condition: () => boolean): Promise<void> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error("Synthetic completion condition was not reached.")), 4000);
  try { while (!condition()) await once(events, "change", { signal: abort.signal }); }
  finally { clearTimeout(deadline); }
}
export function task(state = TaskState.TASK_STATE_WORKING, text = "", id = "task-1", contextId = "context-1") {
  return Task.fromJSON({ id, contextId, status: { state, ...(text && state !== TaskState.TASK_STATE_COMPLETED ? {
    message: Message.toJSON(Message.fromJSON({ messageId: "status-message", role: "ROLE_AGENT", contextId, parts: [{ text }] })),
  } : {}) }, artifacts: text && state === TaskState.TASK_STATE_COMPLETED ? [{ artifactId: "answer", parts: [{ text }] }] : [] });
}

/** Native official client, synthetic transport: IDs and state survive local Pi session reopen. */
export class Peer {
  readonly events = new EventEmitter();
  readonly agentCard = card("https://synthetic.invalid/a2a");
  readonly tasks = new Map<string, Task>();
  readonly sent: SendMessageRequest[] = [];
  readonly reads: string[] = [];
  readonly subscriptions: string[] = [];
  active = 0;
  cancellations = 0;
  direct?: Message | Task;
  read?: (id: string) => Task | Promise<Task>;
  stream?: (id: string, signal: AbortSignal) => AsyncGenerator<StreamResponse, void, undefined>;
  private queues = new Map<string, Set<{ items: StreamResponse[]; wake: () => void }>>();
  readonly client: Client;
  constructor() {
    const transport = {
      protocolName: "JSONRPC", protocolVersion: "1.0",
      sendMessage: async (request: SendMessageRequest) => {
        this.sent.push(structuredClone(request));
        if (this.direct) return structuredClone(this.direct);
        const id = request.message?.taskId || `task-${this.sent.length}`, contextId = request.message?.contextId || "context-1";
        const value = task(TaskState.TASK_STATE_WORKING, "", id, contextId);
        this.tasks.set(id, value); this.events.emit("change");
        return structuredClone(value);
      },
      getTask: async (request: { id: string }) => {
        this.reads.push(request.id); this.events.emit("change");
        const value = this.read ? await this.read(request.id) : this.tasks.get(request.id);
        assert.ok(value, "Synthetic task must exist");
        return structuredClone(value);
      },
      resubscribeTask: (request: { id: string }, options: { signal: AbortSignal }) => this.subscribe(request.id, options.signal),
      cancelTask: async () => { this.cancellations++; throw new TaskNotCancelableError(); },
    } as unknown as Transport;
    this.client = new Client(transport, this.agentCard);
  }
  private async *subscribe(id: string, signal: AbortSignal): AsyncGenerator<StreamResponse, void, undefined> {
    this.subscriptions.push(id); this.active++; this.events.emit("change");
    try {
      if (this.stream) { yield* this.stream(id, signal); return; }
      const queue = { items: [] as StreamResponse[], wake: () => {} };
      let queues = this.queues.get(id);
      if (!queues) this.queues.set(id, queues = new Set());
      queues.add(queue);
      try {
        yield StreamResponse.fromJSON({ task: Task.toJSON(this.tasks.get(id)!) });
        for (;;) {
          signal.throwIfAborted();
          if (!queue.items.length) {
            const next = deferred(); queue.wake = () => next.resolve();
            const abort = () => next.reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            try { signal.throwIfAborted(); await next.promise; }
            finally { signal.removeEventListener("abort", abort); queue.wake = () => {}; }
          }
          while (queue.items.length) yield queue.items.shift()!;
        }
      } finally { queues.delete(queue); }
    } finally { this.active--; this.events.emit("change"); }
  }
  publish(id: string, event: StreamResponse): void {
    for (const queue of this.queues.get(id) ?? []) { queue.items.push(event); queue.wake(); }
  }
  settle(id = "task-1", state = TaskState.TASK_STATE_COMPLETED, text = "Synthetic remote answer"): void {
    const previous = this.tasks.get(id)!;
    const value = task(state, text, id, previous.contextId);
    this.tasks.set(id, value);
    this.publish(id, StreamResponse.fromJSON({ task: Task.toJSON(value) }));
    this.events.emit("change");
  }
}

/** An actual official-SDK HTTP/SSE peer with explicit admission/completion gates and no model. */
export async function httpPeer() {
  const release = deferred<string>(), subscribed = deferred(), executed = deferred();
  const agentCard = card("http://127.0.0.1:1/a2a");
  let sends = 0, cancels = 0, subscriptions = 0;
  const handler = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), {
    async execute(request, bus) {
      sends++; executed.resolve();
      bus.publish(AgentEvent.task(task(TaskState.TASK_STATE_WORKING, "", request.taskId, request.contextId)));
      const answer = await release.promise;
      bus.publish(AgentEvent.task(task(TaskState.TASK_STATE_COMPLETED, answer, request.taskId, request.contextId)));
      bus.finished();
    },
    async cancelTask() { cancels++; throw new TaskNotCancelableError(); },
  });
  const app = express(); app.use(express.json());
  app.get("/.well-known/agent-card.json", (_request, response) => response.json(AgentCard.toJSON(agentCard)));
  app.use("/a2a", (request, _response, next) => {
    if (request.body?.method === "SubscribeToTask") { subscriptions++; subscribed.resolve(); }
    next();
  }, jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agentCard.supportedInterfaces[0].url = `${baseUrl}/a2a`;
  return { baseUrl, release, subscribed, executed, counts: () => ({ sends, cancels, subscriptions }),
    close: async () => {
      release.resolve("Synthetic fixture cleanup");
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
