import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentCard, Message } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import {
  connectAgent,
  endpoint,
  isTask,
  sendText,
  textOf,
  safeError,
} from "../src/client.ts";
import { bearerAuth, createA2AServer } from "../src/server.ts";
import { card, fixture } from "./fixtures/agent.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });

test("generic client interoperates with an official-SDK server that does not use Pi", async (t) => {
  const agentCard = card("http://127.0.0.1:1/a2a");
  const handler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    {
      async execute(request, bus) {
        bus.publish(
          AgentEvent.message(
            Message.fromJSON({
              messageId: "non-pi-answer",
              contextId: request.contextId,
              role: "ROLE_AGENT",
              parts: [
                { text: "Hello from a non-Pi agent", mediaType: "text/plain" },
              ],
            }),
          ),
        );
        bus.finished();
      },
      async cancelTask() {
        throw new TaskNotCancelableError();
      },
    },
  );
  const server = createA2AServer(handler, {
    allowUnauthenticatedLoopback: true,
  });
  t.after(() => close(server));
  const url = await listen(server);
  agentCard.supportedInterfaces[0].url = `${url}/a2a`;
  const client = await connectAgent(url, { allowHttpLoopback: true });
  const message = await sendText(client, "Hello", { messageId: "foreign-1" });
  assert.equal(isTask(message), false);
  assert.equal(textOf(message), "Hello from a non-Pi agent");
});

test("local HTTP and credential-bearing URLs are opt-in or rejected", () => {
  assert.throws(() => endpoint("http://127.0.0.1:8000"), /HTTPS/);
  assert.throws(() => endpoint("http://example.invalid", true), /HTTPS/);
  assert.throws(
    () => endpoint("https://user:pass@example.invalid"),
    /credential-free/,
  );
  assert.throws(
    () => endpoint("https://example.invalid/?auth=synthetic"),
    /credential-free/,
  );
  assert.equal(endpoint("http://127.0.0.1:8000", true).hostname, "127.0.0.1");
});

test("Agent Cards cannot redirect traffic or credentials to an unconfigured origin", async (t) => {
  let foreignCalls = 0;
  const foreign = createServer((_request, response) => {
    foreignCalls++;
    response.end("{}");
  });
  t.after(() => close(foreign));
  const foreignUrl = await listen(foreign);
  const discovery = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(AgentCard.toJSON(card(`${foreignUrl}/a2a`))));
  });
  t.after(() => close(discovery));
  const url = await listen(discovery);
  let client;
  try {
    client = await connectAgent(url, {
      allowHttpLoopback: true,
      headers: () => ({ Authorization: "Bearer synthetic-test-value" }),
    });
    await sendText(client, "Do not leak", { messageId: "trust-test" });
    assert.fail("An unconfigured origin must not be contacted");
  } catch (error) {
    assert.match(String(error), /not configured as trusted/);
  }
  assert.equal(foreignCalls, 0);
});

test("HTTP discovery redirects never forward credentials", async (t) => {
  let foreignCalls = 0;
  const foreign = createServer((_request, response) => {
    foreignCalls++;
    response.end("{}");
  });
  t.after(() => close(foreign));
  const destination = await listen(foreign);
  const redirect = createServer((_request, response) => {
    response.writeHead(302, { Location: destination });
    response.end();
  });
  t.after(() => close(redirect));
  await assert.rejects(
    connectAgent(await listen(redirect), {
      allowHttpLoopback: true,
      headers: () => ({ Authorization: "Bearer synthetic-test-value" }),
    }),
  );
  assert.equal(foreignCalls, 0);
});

test("server authentication fails closed by default, including discovery", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const server = createA2AServer(f.adapter);
  t.after(() => close(server));
  const url = await listen(server);
  assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401);
  assert.equal(
    (await fetch(`${url}/a2a`, { method: "POST", body: "{}" })).status,
    401,
  );
  assert.equal(f.faux.state.callCount, 0);
});

test("bearer authentication reads host credentials without putting them in messages", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const server = createA2AServer(f.adapter, {
    authenticate: bearerAuth(() => "synthetic-auth-value", "fixture-owner"),
  });
  t.after(() => close(server));
  const url = await listen(server);
  assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401);
  assert.equal(
    (
      await fetch(`${url}/.well-known/agent-card.json`, {
        headers: { Authorization: "Bearer synthetic-auth-value" },
      })
    ).status,
    200,
  );
  assert.equal(f.faux.state.callCount, 0);
});

test("missing/unsupported protocol versions and oversized bodies fail before admission", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "ListTasks",
    params: {},
  });
  for (const version of [undefined, "99.0"]) {
    const response = await fetch(`${f.baseUrl}/a2a`, {
      method: "POST",
      headers: version ? { "A2A-Version": version } : {},
      body: payload,
    });
    assert.equal(response.status, 400);
  }
  const large = await fetch(`${f.baseUrl}/a2a`, {
    method: "POST",
    headers: { "A2A-Version": "1.0" },
    body: "x".repeat(65_537),
  });
  assert.equal(large.status, 413);
  assert.equal(f.faux.state.callCount, 0);
});

test("malformed JSON is a protocol parse error, not a false successful response", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const response = await fetch(`${f.baseUrl}/a2a`, {
    method: "POST",
    headers: { "A2A-Version": "1.0" },
    body: "{",
  });
  const document = (await response.json()) as { error: { code: number } };
  assert.equal(document.error.code, -32700);
});

test("complete JSON responses are byte-bounded and remote diagnostics stay sanitized", async (t) => {
  const huge = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }));
  });
  t.after(() => close(huge));
  await assert.rejects(
    connectAgent(await listen(huge), { allowHttpLoopback: true }),
    /2 MiB/,
  );
  const result = safeError(
    new Error("raw provider failure with Bearer synthetic-value"),
  );
  assert.equal(result.code, "A2A_REQUEST_FAILED");
  assert.ok(!JSON.stringify(result).includes("synthetic-value"));
});
