import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { AgentCard } from "@a2a-js/sdk";
import { createDurableA2A, type DurableA2AOptions } from "../../src/durable.ts";
import {
  createA2AServer,
  A2A_DOCUMENT_MAX_BODY_BYTES,
  type HttpOptions,
} from "../../src/server.ts";
import { connectAgent } from "../../src/client.ts";

export const context = BACKGROUND_CONTEXT;
export function card(
  url: string,
  images = false,
  files = false,
  documents = false,
) {
  return AgentCard.fromJSON({
    name: "Test agent",
    description: "Synthetic local test agent",
    version: "0.1.0",
    supportedInterfaces: [
      { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: true },
    defaultInputModes: [
      "text/plain",
      ...(images ? ["image/jpeg", "image/png"] : []),
      ...(documents ? ["application/pdf", "text/markdown", "text/csv"] : []),
    ],
    defaultOutputModes: files
      ? ["text/plain", "image/png", "image/jpeg", "image/webp"]
      : ["text/plain"],
    skills: [
      {
        id: "reply",
        name: "Reply",
        description: "Reply to synthetic test messages",
        tags: ["test"],
      },
    ],
  });
}
export async function fixture(
  options: {
    answers?: string[];
    tokensPerSecond?: number;
    storage?: Storage;
    registry?: Registry;
    retries?: number;
    mesh?: DurableA2AOptions["mesh"];
    whenBusy?: DurableA2AOptions["whenBusy"];
    validateInput?: DurableA2AOptions["validateInput"];
    clientHeaders?: () => NonNullable<ConstructorParameters<typeof Headers>[0]>;
    classifyAnswer?: DurableA2AOptions["classifyAnswer"];
    http?: HttpOptions;
    images?: boolean;
    documents?: boolean;
    push?: DurableA2AOptions["push"];
    fileArtifacts?: DurableA2AOptions["fileArtifacts"];
  } = {},
) {
  const faux = fauxProvider({ tokensPerSecond: options.tokensPerSecond });
  faux.setResponses(
    (options.answers ?? ["Hello over A2A"]).map((answer) =>
      fauxAssistantMessage([fauxText(answer)]),
    ),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const reports: string[] = [];
  const harness = await Harness.open(
    options.storage ?? new MemoryStorage(),
    {
      models,
      registry: options.registry ?? createRegistry(),
      onReport: (report) => reports.push(report.kind),
      settings: {
        compaction: { enabled: false },
        retry: { maxRetries: options.retries ?? 0, baseDelayMs: 1 },
        afterFailedRun: "withdraw",
      },
    },
    context,
  );
  const model = faux.getModel();
  const root = await harness.root(context, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  const agentCard = card(
    "http://127.0.0.1:1/a2a",
    options.images,
    Boolean(options.fileArtifacts),
    options.documents,
  );
  if (options.push) agentCard.capabilities!.pushNotifications = true;
  const adapter = createDurableA2A({
    harness,
    card: agentCard,
    conversation: () => root,
    mesh: options.mesh,
    whenBusy: options.whenBusy,
    validateInput: options.validateInput,
    classifyAnswer: options.classifyAnswer,
    images: options.images,
    documents: options.documents,
    push: options.push,
    fileArtifacts: options.fileArtifacts,
    pollIntervalMs: 10,
  });
  const server = createA2AServer(
    adapter,
    options.http ?? {
      allowUnauthenticatedLoopback: true,
      ...(options.documents
        ? { maxBodyBytes: A2A_DOCUMENT_MAX_BODY_BYTES }
        : {}),
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  agentCard.supportedInterfaces[0].url = `${baseUrl}/a2a`;
  const client = await connectAgent(baseUrl, {
    allowHttpLoopback: true,
    headers: options.clientHeaders,
  });
  harness.resume();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await adapter.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await harness.close(context);
    })());
  return {
    faux,
    models,
    harness,
    root,
    adapter,
    client,
    server,
    baseUrl,
    close,
    reports,
  };
}
