import { Worker } from "node:worker_threads";
import { ContentTypeNotSupportedError } from "@a2a-js/sdk/errors";

export const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
] as const;
export const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_BYTES = 128 * 1024;
export const MAX_DOCUMENT_PAGES = 32;
export interface InputDocument {
  data: Buffer;
  mediaType: string;
  filename: string;
}
export function documentRejected(message: string): never {
  throw new ContentTypeNotSupportedError({
    message,
    metadata: { input: "document", admission: "rejected" },
  });
}
export function validateDocument(document: InputDocument): void {
  if (
    !DOCUMENT_MEDIA_TYPES.includes(
      document.mediaType as (typeof DOCUMENT_MEDIA_TYPES)[number],
    )
  )
    documentRejected("This document type is not supported.");
  if (
    !document.filename.trim() ||
    Buffer.byteLength(document.filename) > 256 ||
    /[\p{Cc}\p{Cf}\\/]/u.test(document.filename)
  )
    documentRejected(
      "Use a document filename without paths or control characters, at most 256 UTF-8 bytes.",
    );
  if (
    !Buffer.isBuffer(document.data) ||
    !document.data.length ||
    document.data.length > MAX_DOCUMENT_BYTES
  )
    documentRejected("Attach one document of at most 4 MiB.");
  if (document.mediaType === "application/pdf") {
    if (document.data.subarray(0, 5).toString("ascii") !== "%PDF-")
      documentRejected("The selected document is not a PDF.");
  } else {
    if (document.data.length > MAX_DOCUMENT_TEXT_BYTES)
      documentRejected("Text documents must be at most 128 KiB.");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        document.data,
      );
      // eslint-disable-next-line no-control-regex -- Reject control bytes in untrusted UTF-8 documents.
      if (!text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
        documentRejected(
          "Select a nonempty UTF-8 text document, not a binary file.",
        );
    } catch {
      documentRejected(
        "Select a nonempty UTF-8 text document, not a binary file.",
      );
    }
  }
}
let activeDecoders = 0;
/** No PDF scripts, provider upload, filesystem staging, or network references. */
export async function documentText(document: InputDocument): Promise<string> {
  validateDocument(document);
  if (document.mediaType !== "application/pdf")
    return new TextDecoder("utf-8", { fatal: true }).decode(document.data);
  if (activeDecoders >= 2)
    documentRejected(
      "The document reader is busy. The message was not admitted; try again later.",
    );
  activeDecoders++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const current = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "./document-worker.ts"
          : "./document-worker.js",
        import.meta.url,
      ),
      {
        workerData: {
          data: new Uint8Array(document.data),
          pages: MAX_DOCUMENT_PAGES,
          textBytes: MAX_DOCUMENT_TEXT_BYTES,
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
        stdout: true,
        stderr: true,
      },
    );
    worker = current;
    current.stdout.resume();
    current.stderr.resume();
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("timeout"));
      }, 15_000);
      current.once("message", (result: { text?: string; error?: string }) => {
        if (result.error) reject(new Error(result.error));
        else if (
          typeof result.text === "string" &&
          result.text.trim() &&
          Buffer.byteLength(result.text) <= MAX_DOCUMENT_TEXT_BYTES
        )
          resolve(result.text);
        else reject(new Error("unreadable"));
      });
      current.once("error", (error) => {
        reject(
          new Error(
            (error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY"
              ? "unreadable"
              : "unavailable",
          ),
        );
      });
      current.once("exit", () => {
        reject(new Error("unreadable"));
      });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "";
      documentRejected(
        message === "pages"
          ? "PDFs must contain at most 32 pages. Nothing was truncated."
          : message === "text"
            ? "The PDF text exceeds 128 KiB. Nothing was truncated."
            : message === "empty"
              ? "One or more PDF pages have no readable text. Scanned or blank pages are unsupported; attach page photos or a text-only copy instead."
              : message === "encrypted"
                ? "Encrypted PDFs are not supported. Select an unlocked copy."
                : message === "unavailable"
                  ? "The document reader is unavailable. No message was admitted; try again later."
                  : "The PDF could not be read within the document limits. Select a readable, unlocked PDF.",
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (worker) await worker.terminate();
    activeDecoders--;
  }
}
