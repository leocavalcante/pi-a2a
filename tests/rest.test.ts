import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentCard, Message } from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import { connectAgent, sendText, textOf } from "../src/client.ts";
import { card } from "./fixtures/agent.ts";

test("client negotiates an HTTP+JSON/REST-only non-Pi peer", async (t) => {
  const agentCard = card("http://127.0.0.1:1/rest");
  const restInterface = agentCard.supportedInterfaces[0];
  assert(restInterface);
  restInterface.protocolBinding = "HTTP+JSON";
  const handler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    {
      async execute(request, bus) {
        bus.publish(
          AgentEvent.message(
            Message.fromJSON({
              messageId: "rest-reply",
              contextId: request.contextId,
              role: "ROLE_AGENT",
              parts: [{ text: "REST-only peer" }],
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
  const app = express();
  app.use(express.json());
  app.get("/.well-known/agent-card.json", (_request, response) =>
    response.json(AgentCard.toJSON(agentCard)),
  );
  app.use(
    "/rest",
    restHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  );
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  restInterface.url = `${url}/rest`;
  const client = await connectAgent(url, { allowHttpLoopback: true });
  assert.equal(
    textOf(
      await sendText(client, "A synthetic REST request", {
        messageId: "rest-only",
      }),
    ),
    "REST-only peer",
  );
});
