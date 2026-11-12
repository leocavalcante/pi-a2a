import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SendMessageRequest, TaskPushNotificationConfig } from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { isTask, sendText } from "../src/client.ts";
import { context, fixture } from "./fixtures/agent.ts";
import { deferred } from "./fixtures/cleanup.ts";
const token = "synthetic-callback-credential-12345678";
async function callback() {
  const calls: { body: string; auth?: string; type?: string }[] = [],
    events = new EventEmitter();
  let code = 202;
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      calls.push({
        body,
        auth: request.headers.authorization,
        type: request.headers["content-type"],
      });
      response.writeHead(code);
      response.end();
      events.emit("event");
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    calls,
    events,
    origin,
    code: (value: number) => {
      code = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}
const config = (url: string, taskId = "", id = "mobile") =>
  TaskPushNotificationConfig.fromJSON({
    id,
    taskId,
    url,
    authentication: { scheme: "Bearer", credentials: token },
  });
const owner = new ServerCallContext({
  user: { isAuthenticated: true, userName: "loopback-owner" },
});

test("A2A push is delivered without a task reader or SSE observer, then deduplicated", async (t) => {
  const receiver = await callback();
  t.after(receiver.close);
  const f = await fixture({
    push: { allowedOrigins: [receiver.origin], allowHttpLoopback: true },
  });
  t.after(f.close);
  const response = await f.client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: "push-first",
        role: "ROLE_USER",
        parts: [{ text: "Synthetic push test" }],
      },
      configuration: {
        returnImmediately: true,
        taskPushNotificationConfig: TaskPushNotificationConfig.toJSON(
          config(`${receiver.origin}/push`),
        ),
      },
    }),
  );
  assert.ok(isTask(response));
  await f.root.waitForIdle(context);
  const delivered = once(receiver.events, "event", {
    signal: AbortSignal.timeout(5000),
  });
  f.adapter.startPush();
  await delivered;
  await f.adapter.close();
  assert.equal(receiver.calls.length, 1);
  const call = receiver.calls[0];
  assert(call);
  const event = JSON.parse(call.body);
  assert.equal(event.task.id, response.id);
  assert.equal(event.task.status.state, "TASK_STATE_COMPLETED");
  assert.deepEqual(event.task.history ?? [], []);
  assert.equal(call.type, "application/a2a+json");
  assert.equal(call.auth, `Bearer ${token}`);
  assert.ok(!JSON.stringify(event).includes(token));
  assert.equal(f.faux.state.callCount, 1);
});

test("callback guard withholds both new payloads and exact saved retries across reopen", async (t) => {
  const defer = deferred(t);
  const receiver = await callback();
  defer(receiver.close);
  receiver.code(503);
  const directory = await mkdtemp(join(tmpdir(), "a2a-push-guard-"));
  defer(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const database = join(directory, "agent.sqlite");
  let withheld = true,
    checks = 0;
  const push = {
    allowedOrigins: [receiver.origin],
    allowHttpLoopback: true,
    validatePayload: (value: unknown) => {
      checks++;
      assert.match(JSON.stringify(value), /Hello over A2A/);
      if (withheld) throw new Error("Synthetic sensitive payload withheld.");
    },
  };
  const f = await fixture({
    storage: await openNodeSqliteStorage(database),
    push,
  });
  defer(f.close);
  const task = await sendText(f.client, "Synthetic guarded notification", {
    messageId: "guarded-push",
  });
  assert.ok(isTask(task));
  await f.adapter.createTaskPushNotificationConfig(
    config(`${receiver.origin}/push`, task.id),
    owner,
  );
  await f.root.waitForIdle(context);
  await f.adapter.flushPush();
  assert.equal(receiver.calls.length, 0);
  withheld = false;
  await f.adapter.flushPush();
  assert.equal(receiver.calls.length, 1);
  await f.close();
  await delay(1050);
  const reopened = await fixture({
    storage: await openNodeSqliteStorage(database),
    push,
    answers: [],
  });
  defer(reopened.close);
  withheld = true;
  await reopened.adapter.flushPush();
  assert.equal(receiver.calls.length, 1);
  withheld = false;
  receiver.code(202);
  await reopened.adapter.flushPush();
  assert.equal(receiver.calls.length, 2);
  const firstCall = receiver.calls[0];
  const secondCall = receiver.calls[1];
  assert(firstCall);
  assert(secondCall);
  assert.equal(firstCall.body, secondCall.body);
  assert.equal(checks, 4);
  assert.equal(reopened.faux.state.callCount, 0);
});

test("push URL and authentication validation reject before model admission", async (t) => {
  const f = await fixture({
    push: { allowedOrigins: ["https://callback.example.invalid"] },
  });
  t.after(f.close);
  for (const url of [
    "http://127.0.0.1/private",
    "https://elsewhere.invalid/push",
    "https://user:pass@callback.example.invalid/push",
    "https://callback.example.invalid/push?credential=x",
  ]) {
    await assert.rejects(
      f.client.sendMessage(
        SendMessageRequest.fromJSON({
          message: {
            messageId: "unsafe",
            role: "ROLE_USER",
            parts: [{ text: "Do not execute" }],
          },
          configuration: {
            taskPushNotificationConfig: TaskPushNotificationConfig.toJSON(
              config(url),
            ),
          },
        }),
      ),
      /push|callback|trusted/i,
    );
  }
  assert.equal(f.faux.state.callCount, 0);
});

test("push configurations are scoped, paginated and removable", async (t) => {
  const f = await fixture({
    push: { allowedOrigins: ["https://callback.example.invalid"] },
  });
  t.after(f.close);
  const task = await sendText(f.client, "Synthetic", {
    messageId: "scoped-push",
  });
  assert.ok(isTask(task));
  for (const id of ["a", "b"])
    await f.adapter.createTaskPushNotificationConfig(
      config("https://callback.example.invalid/push", task.id, id),
      owner,
    );
  const first = await f.adapter.listTaskPushNotificationConfigs(
    { tenant: "", taskId: task.id, pageSize: 1, pageToken: "" },
    owner,
  );
  const firstConfig = first.configs[0];
  assert(firstConfig);
  assert.equal(firstConfig.id, "a");
  assert.ok(first.nextPageToken);
  const second = await f.adapter.listTaskPushNotificationConfigs(
    {
      tenant: "",
      taskId: task.id,
      pageSize: 1,
      pageToken: first.nextPageToken,
    },
    owner,
  );
  const secondConfig = second.configs[0];
  assert(secondConfig);
  assert.equal(secondConfig.id, "b");
  const foreign = new ServerCallContext({
    user: { isAuthenticated: true, userName: "other-owner" },
  });
  await assert.rejects(
    f.adapter.getTaskPushNotificationConfig(
      { tenant: "", taskId: task.id, id: "a" },
      foreign,
    ),
    /not found/i,
  );
  await f.adapter.deleteTaskPushNotificationConfig(
    { tenant: "", taskId: task.id, id: "a" },
    owner,
  );
  await assert.rejects(
    f.adapter.getTaskPushNotificationConfig(
      { tenant: "", taskId: task.id, id: "a" },
      owner,
    ),
    /not found/i,
  );
});

test("unacknowledged push survives SQLite reopen and reuses the exact event body", async (t) => {
  const defer = deferred(t);
  const receiver = await callback();
  defer(receiver.close);
  receiver.code(503);
  const directory = await mkdtemp(join(tmpdir(), "a2a-push-reopen-"));
  defer(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const database = join(directory, "agent.sqlite"),
    push = { allowedOrigins: [receiver.origin], allowHttpLoopback: true };
  const f = await fixture({
    storage: await openNodeSqliteStorage(database),
    push,
  });
  defer(f.close);
  const task = await sendText(f.client, "Synthetic retained notification", {
    messageId: "persist-push",
  });
  assert.ok(isTask(task));
  await f.adapter.createTaskPushNotificationConfig(
    config(`${receiver.origin}/push`, task.id),
    owner,
  );
  await f.root.waitForIdle(context);
  await f.adapter.flushPush();
  assert.equal(receiver.calls.length, 1);
  await f.close();
  await delay(1050);
  receiver.code(202);
  const reopened = await fixture({
    storage: await openNodeSqliteStorage(database),
    push,
    answers: [],
  });
  defer(reopened.close);
  await reopened.adapter.flushPush();
  await reopened.adapter.flushPush();
  assert.equal(receiver.calls.length, 2);
  const firstCall = receiver.calls[0];
  const secondCall = receiver.calls[1];
  assert(firstCall);
  assert(secondCall);
  assert.equal(firstCall.body, secondCall.body);
  assert.equal(reopened.faux.state.callCount, 0);
});
