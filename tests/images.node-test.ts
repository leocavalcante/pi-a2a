import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SendMessageRequest } from "@a2a-js/sdk";
import { isTask, waitForTask } from "../src/client.ts";
import { fixture } from "./fixtures/agent.ts";
import { deferred } from "./fixtures/cleanup.ts";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQioAAAAASUVORK5CYII=";
const request = (image = true) =>
  SendMessageRequest.fromJSON({
    message: {
      messageId: "retained-photo",
      role: "ROLE_USER",
      parts: [
        { text: "Describe this synthetic photo; do not change inventory." },
        ...(image ? [{ raw: png, mediaType: "image/png" }] : []),
      ],
    },
    configuration: { returnImmediately: true, historyLength: 0 },
  });

test("photo bytes reach the provider and receipt dedup survives reopen, including image removal conflicts", async (t) => {
  const defer = deferred(t);
  const directory = await mkdtemp(join(tmpdir(), "a2a-images-reopen-"));
  defer(() =>
    rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  );
  const database = join(directory, "agent.sqlite");
  const f = await fixture({
    storage: await openNodeSqliteStorage(database),
    images: true,
  });
  defer(f.close);
  let observed = false;
  f.faux.setResponses([
    (context) => {
      const user = context.messages.findLast(
        (message) => message.role === "user",
      );
      assert.ok(user && Array.isArray(user.content));
      const image = user.content.find((part) => part.type === "image");
      assert.ok(image && image.type === "image");
      assert.equal(image.data, png);
      assert.equal(image.mimeType, "image/png");
      observed = true;
      return fauxAssistantMessage([fauxText("Synthetic photo observed")]);
    },
  ]);
  const admitted = await f.client.sendMessage(request());
  assert.ok(isTask(admitted));
  const done = await waitForTask(f.client, admitted.id, { intervalMs: 10 });
  assert.equal(done.status?.state, 3);
  assert.equal(observed, true);
  assert.ok(!JSON.stringify(done).includes(png));
  await assert.rejects(
    f.client.sendMessage(request(false)),
    /message ID already belongs/,
  );
  await f.close();
  const reopened = await fixture({
    storage: await openNodeSqliteStorage(database),
    images: true,
    answers: [],
  });
  defer(reopened.close);
  const same = await reopened.client.sendMessage(request());
  assert.ok(isTask(same));
  assert.equal(same.id, admitted.id);
  await assert.rejects(
    reopened.client.sendMessage(request(false)),
    /message ID already belongs/,
  );
  assert.equal(reopened.faux.state.callCount, 0);
});
