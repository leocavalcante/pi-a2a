import { onTestFinished, test } from "bun:test";
import assert from "node:assert/strict";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { textRequest } from "../src/client.ts";
import { fixture } from "./fixtures/agent.ts";

test("direct admission returns detached task metadata, not Chord proxies", async () => {
  const f = await fixture();
  onTestFinished(f.close);
  const context = new ServerCallContext({
    user: { isAuthenticated: true, userName: "loopback-owner" },
    requestedVersion: "1.0",
  });
  const value = await f.adapter.sendMessage(
    textRequest("Synthetic input", { messageId: "direct" }),
    context,
  );
  assert.ok(value.id);
  assert.doesNotThrow(() => structuredClone(value));
});
