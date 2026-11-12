import assert from "node:assert/strict";
import test from "node:test";
import { SendMessageRequest } from "@a2a-js/sdk";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { fixture } from "./fixtures/agent.ts";
import { syntheticPdf } from "./fixtures/pdf.ts";

test("host input guard sees extracted PDF text and rejects before model admission", async (t) => {
  let checked = 0;
  const f = await fixture({
    documents: true,
    validateInput: (content) => {
      checked++;
      assert.match(JSON.stringify(content), /APRICOT-783/);
      throw new Error("Synthetic input withheld.");
    },
  });
  t.after(f.close);
  await assert.rejects(
    f.client.sendMessage(
      SendMessageRequest.fromJSON({
        message: {
          messageId: "guarded-pdf",
          role: "ROLE_USER",
          parts: [
            {
              raw: syntheticPdf().toString("base64"),
              mediaType: "application/pdf",
              filename: "proof.pdf",
            },
          ],
        },
      }),
    ),
    /Agent unavailable/i,
  );
  assert.equal(checked, 1);
  assert.equal(f.faux.state.callCount, 0);
});

test("host input validation cannot rewrite immutable admitted content", async (t) => {
  const f = await fixture({
    documents: true,
    validateInput: (content) => {
      if (Array.isArray(content))
        content.splice(0, content.length, {
          type: "text",
          text: "Rewritten by validator",
        });
    },
  });
  t.after(f.close);
  let observed = false;
  f.faux.setResponses([
    (modelContext) => {
      const input = modelContext.messages.findLast(
        (message) => message.role === "user",
      );
      assert.match(JSON.stringify(input), /Original immutable document/);
      assert.doesNotMatch(JSON.stringify(input), /Rewritten by validator/);
      observed = true;
      return fauxAssistantMessage("Original content retained.");
    },
  ]);
  const response = await f.client.sendMessage(
    SendMessageRequest.fromJSON({
      message: {
        messageId: "isolated-validator",
        role: "ROLE_USER",
        parts: [
          {
            raw: Buffer.from("Original immutable document").toString("base64"),
            mediaType: "text/plain",
            filename: "proof.txt",
          },
        ],
      },
    }),
  );
  assert.ok(response);
  assert.equal(observed, true);
});
