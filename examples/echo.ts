// Model-free demonstration. This scripted provider never calls a paid API.
import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentCard } from "@a2a-js/sdk";
import { createDurableA2A } from "../src/durable.ts";
import { createA2AServer } from "../src/server.ts";

const context = BACKGROUND_CONTEXT;
const dir = resolve(process.env.DEMO_DATA_DIR ?? "data");
await mkdir(dir, { recursive: true, mode: 0o700 });
const lockFile = join(dir, "demo.owner");
const lock = await open(lockFile, "wx", 0o600).catch(() => {
  console.error(
    "An owner lock already exists. Verify the previous owner has stopped before removing a stale lock.",
  );
  process.exit(73);
});
await lock.writeFile(String(process.pid));
const faux = fauxProvider();
faux.setResponses(
  Array.from({ length: 256 }, () =>
    fauxAssistantMessage([
      fauxText("Hello over A2A. This is a scripted, model-free Durable reply."),
    ]),
  ),
);
const models = createModels();
models.setProvider(faux.provider);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(dir, "demo.sqlite")),
  {
    models,
    registry: createRegistry(),
    settings: { compaction: { enabled: false } },
  },
  context,
);
const model = faux.getModel();
const conversation = await harness.root(context, {
  agent: { model: { provider: model.provider, modelId: model.id } },
});
const port = Number(process.env.PORT ?? 7777);
const card = AgentCard.fromJSON({
  name: "Durable demo",
  version: "0.1.0",
  description: "A persistent agent with a scripted local provider",
  supportedInterfaces: [
    {
      url: `http://127.0.0.1:${port}/a2a`,
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    },
  ],
  capabilities: { streaming: true },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    {
      id: "greeting",
      name: "Greeting",
      description: "Return a scripted greeting",
      tags: ["demo"],
    },
  ],
});
const handler = createDurableA2A({
  harness,
  card,
  conversation: () => conversation,
});
const server = createA2AServer(handler, { allowUnauthenticatedLoopback: true });
server.listen(port, "127.0.0.1", () =>
  console.log(`A2A demo: http://127.0.0.1:${port}`),
);
harness.resume();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close();
  await harness.close(context); // Suspend pending work; do not abort the conversation.
  await lock.close();
  await unlink(lockFile);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
