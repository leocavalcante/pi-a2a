import assert from "node:assert/strict";
import test from "node:test";
import { AgentCard } from "@a2a-js/sdk";
import { connectAgent, LocalA2AError, safeError } from "../src/client.ts";
import { card } from "./fixtures/agent.ts";
import { deferred } from "./fixtures/completion.ts";

const base = "http://127.0.0.1:7777";
const urlOf = (input: Parameters<typeof fetch>[0]) =>
  new URL(input instanceof Request ? input.url : input.toString());

test("native subscriptions reuse origin guards and never send credentials to an untrusted card endpoint", async () => {
  let requests = 0,
    credentials = 0;
  const client = await connectAgent(base, {
    allowHttpLoopback: true,
    headers: () => {
      credentials++;
      return { Authorization: "Bearer synthetic-only" };
    },
    fetch: async (input) => {
      requests++;
      assert.equal(urlOf(input).origin, base);
      return new Response(
        JSON.stringify(
          AgentCard.toJSON(card("https://not-trusted.invalid/a2a")),
        ),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  await assert.rejects(
    client.resubscribeTask({ id: "retained-task", tenant: "" }).next(),
    (error) =>
      error instanceof LocalA2AError && error.code === "UNTRUSTED_ORIGIN",
  );
  assert.equal(requests, 1);
  assert.equal(credentials, 1);
});

test("subscription authentication failures stay typed, sanitized and fail closed before reading diagnostics", async () => {
  for (const status of [401, 403]) {
    let requests = 0;
    const client = await connectAgent(base, {
      allowHttpLoopback: true,
      fetch: async (input, init) => {
        requests++;
        assert.equal(init?.redirect, "error");
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Fetch init is optional in the Node test type definitions.
        assert.ok(init?.signal);
        if (urlOf(input).pathname === "/.well-known/agent-card.json")
          return new Response(
            JSON.stringify(AgentCard.toJSON(card(`${base}/a2a`))),
            { headers: { "content-type": "application/json" } },
          );
        return new Response("Bearer synthetic-private-diagnostic", { status });
      },
    });
    await assert.rejects(
      client.resubscribeTask({ id: "retained-task", tenant: "" }).next(),
      (error) => {
        const safe = safeError(error);
        assert.equal(safe.code, "AUTHENTICATION_FAILED");
        assert.ok(!JSON.stringify(safe).includes("synthetic-private"));
        return true;
      },
    );
    assert.equal(requests, 2);
  }
});

test("an observer's independent abort signal also aborts discovery without disabling request timeouts", async () => {
  const abort = new AbortController(),
    started = deferred();
  const request = connectAgent(base, {
    allowHttpLoopback: true,
    signal: abort.signal,
    fetch: async (_input, init) => {
      assert.ok(init?.signal);
      assert.notEqual(init.signal, abort.signal);
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener(
          "abort",
          () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Mirror fetch rejecting with the abort signal's original reason.
            reject(init.signal!.reason);
          },
          { once: true },
        );
        started.resolve();
      });
    },
  });
  const rejected = assert.rejects(
    request,
    (error) => error instanceof Error && error.name === "AbortError",
  );
  await started.promise;
  abort.abort();
  await rejected;
});
