import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SendMessageRequest, ListTasksRequest } from "@a2a-js/sdk";
import { isTask, waitForTask } from "../src/client.ts";
import { documentText, validateDocument, MAX_DOCUMENT_BYTES } from "../src/documents.ts";
import { fixture } from "./fixtures/agent.ts";
import { syntheticPdf } from "./fixtures/pdf.ts";
import { deferred } from "./fixtures/cleanup.ts";
const pdf = syntheticPdf();
const request = (data = pdf, filename = "proof.pdf", mediaType = "application/pdf") => SendMessageRequest.fromJSON({
  message: { messageId: "retained-document", role: "ROLE_USER", parts: [{ raw: data.toString("base64"), mediaType, filename }] },
  configuration: { returnImmediately: true, historyLength: 0 },
});

test("PDF is opt-in; text/image defaults do not admit a document", async t => {
  const f = await fixture({ images: true }); t.after(f.close);
  await assert.rejects(f.client.sendMessage(request()), /content|media/i);
  assert.equal(f.faux.state.callCount, 0);
});
test("real PDF text reaches the model, history stays bounded, and immutable dedup survives reopen", async t => {
  const defer = deferred(t);
  const directory = await mkdtemp(join(tmpdir(), "a2a-documents-")); defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const database = join(directory, "agent.sqlite");
  const f = await fixture({ storage: await openNodeSqliteStorage(database), documents: true }); defer(f.close);
  let observed = false;
  f.faux.setResponses([context => {
    const user = context.messages.findLast(message => message.role === "user");
    assert.ok(user && Array.isArray(user.content));
    const text = user.content.filter(part => part.type === "text").map(part => part.text).join("\n");
    assert.match(text, /proof\.pdf/); assert.match(text, /\[Page 1\]/); assert.match(text, /APRICOT-783/);
    observed = true;
    return fauxAssistantMessage([fauxText("Read synthetic PDF")]);
  }]);
  const admitted = await f.client.sendMessage(request()); assert.ok(isTask(admitted));
  const done = await waitForTask(f.client, admitted.id, { intervalMs: 10 });
  assert.equal(observed, true); assert.equal(f.faux.state.callCount, 1);
  assert.ok(!JSON.stringify(done).includes(pdf.toString("base64")));
  assert.ok(!JSON.stringify(done.history).includes("APRICOT-783"));
  await assert.rejects(f.client.sendMessage(request(syntheticPdf("changed"))), /message ID already belongs/);
  await assert.rejects(f.client.sendMessage(request(pdf, "renamed.pdf")), /message ID already belongs/);
  await assert.rejects(f.client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "retained-document", role: "ROLE_USER", parts: [{ text: "Removed the document" }] } })), /message ID already belongs/);
  await f.close();
  const reopened = await fixture({ storage: await openNodeSqliteStorage(database), documents: true, answers: [] }); defer(reopened.close);
  const same = await reopened.client.sendMessage(request()); assert.ok(isTask(same)); assert.equal(same.id, admitted.id);
  assert.equal(reopened.faux.state.callCount, 0);
});
test("malformed, empty/scanned, excessive-page and excessive-text PDFs are rejected before model admission", async t => {
  const f = await fixture({ documents: true }); t.after(f.close);
  for (const data of [Buffer.from("not PDF"), Buffer.from("%PDF-1.7\nmalformed"), syntheticPdf(""), syntheticPdf("hello", 33), syntheticPdf("A".repeat(140_000), 1, { width: 2_000_000 }), syntheticPdf("locked", 1, { encrypted: true })]) {
    await assert.rejects(f.client.sendMessage(request(data)), /PDF|document|32|128/i, `Expected no admission for ${data.length}-byte fixture`);
  }
  assert.equal(f.faux.state.callCount, 0);
  const listed = await f.client.listTasks(ListTasksRequest.fromJSON({})); assert.equal(listed.tasks.length, 0);
});
test("document validation rejects paths, URLs, oversized data and more than one document", async t => {
  assert.throws(() => validateDocument({ data: pdf, mediaType: "application/pdf", filename: "../proof.pdf" }));
  assert.throws(() => validateDocument({ data: Buffer.alloc(MAX_DOCUMENT_BYTES + 1), mediaType: "application/pdf", filename: "proof.pdf" }));
  const f = await fixture({ documents: true }); t.after(f.close);
  const multiple = request(); multiple.message!.parts.push(multiple.message!.parts[0]);
  await assert.rejects(f.client.sendMessage(multiple), /one document/);
  await assert.rejects(f.client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: "url", role: "ROLE_USER", parts: [{ url: "https://example.invalid/private.pdf", mediaType: "application/pdf", filename: "proof.pdf" }] } })), /content|media/i);
  assert.equal(f.faux.state.callCount, 0);
});
test("document rejection carries standard pre-admission ErrorInfo on the actual JSON-RPC wire", async t => {
  const f = await fixture({ documents: true }); t.after(f.close);
  const response = await fetch(`${f.baseUrl}/a2a`, { method: "POST", headers: { "Content-Type": "application/json", "A2A-Version": "1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "document-rejection", method: "SendMessage", params: SendMessageRequest.toJSON(request(Buffer.from("not PDF"))) }) });
  const wire = await response.json() as { id: string; error: { code: number; data: { domain: string; reason: string; metadata: object }[] } };
  assert.equal(response.status, 200); assert.equal(wire.id, "document-rejection"); assert.equal(wire.error.code, -32005);
  assert.equal(wire.error.data[0].domain, "a2a-protocol.org"); assert.equal(wire.error.data[0].reason, "CONTENT_TYPE_NOT_SUPPORTED");
  assert.deepEqual(wire.error.data[0].metadata, { input: "document", admission: "rejected" });
  assert.equal(f.faux.state.callCount, 0);
});
test("TXT, Markdown and CSV preserve UTF-8; binary and invalid encodings are rejected", async () => {
  for (const mediaType of ["text/plain", "text/markdown", "text/csv"]) {
    assert.equal(await documentText({ data: Buffer.from("Olá,document\nvalue,42"), filename: "proof.txt", mediaType }), "Olá,document\nvalue,42");
  }
  for (const data of [Buffer.from([0, 1, 2]), Buffer.from([0xff]), Buffer.from(" "), Buffer.alloc(131_073, 65)]) {
    assert.throws(() => validateDocument({ data, filename: "proof.txt", mediaType: "text/plain" }));
  }
});
