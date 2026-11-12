import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

// Isolated so pathological PDF parsing cannot block the server event loop.
const { data, pages, textBytes } = workerData as {
  data: Uint8Array;
  pages: number;
  textBytes: number;
};
try {
  const pdf = await getDocumentProxy(data, {
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    maxImageSize: 16_777_216,
    cMapUrl: undefined,
    standardFontDataUrl: undefined,
  });
  try {
    if (pdf.numPages < 1 || pdf.numPages > pages) throw new Error("pages");
    const extracted: string[] = [];
    let total = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
        )
        .join("")
        // Strip control characters from extracted untrusted document text.
        // eslint-disable-next-line no-control-regex -- These ranges intentionally filter PDF control bytes.
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
        .trim();
      if (!text) throw new Error("empty");
      const section = `[Page ${String(number)}]\n${text}`;
      total += Buffer.byteLength(section) + (extracted.length ? 2 : 0);
      if (total > textBytes) throw new Error("text");
      extracted.push(section);
      page.cleanup();
    }
    // This module runs inside a worker, where parentPort is supplied by Node.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Worker-thread entrypoints always have a parent port.
    parentPort!.postMessage({ text: extracted.join("\n\n") });
  } finally {
    await pdf.loadingTask.destroy();
  }
} catch (error) {
  const exception = error as Error;
  // This module runs inside a worker, where parentPort is supplied by Node.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Worker-thread entrypoints always have a parent port.
  parentPort!.postMessage({
    error:
      exception.name === "PasswordException"
        ? "encrypted"
        : ["pages", "text", "empty"].includes(exception.message)
          ? exception.message
          : "unreadable",
  });
}
