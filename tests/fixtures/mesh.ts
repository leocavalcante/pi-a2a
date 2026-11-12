import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, type Storage } from "@earendil-works/pi-durable";
import { createA2ATools, type DurableA2AOptions } from "../../src/durable.ts";
import { peerBearerAuth } from "../../src/server.ts";
import { configuredAgent, type AgentConfig } from "../../src/config.ts";
import { fixture } from "./agent.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function mesh(
  options: {
    sourceStorage?: Storage;
    sourceAnswers?: string[];
    targetAnswers?: string[];
    targetFileArtifacts?: DurableA2AOptions["fileArtifacts"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "a2a-mesh-"));
  const outgoing = join(directory, "alpha-beta.token"),
    incoming = join(directory, "beta-alpha.token");
  await writeFile(outgoing, "synthetic-alpha-to-beta-credential", {
    mode: 0o600,
  });
  await writeFile(incoming, "synthetic-beta-to-alpha-credential", {
    mode: 0o600,
  });
  const configs: Record<string, AgentConfig> = {
    alpha: { agents: {} },
    beta: { agents: {} },
  };
  const make = async (
    name: "alpha" | "beta",
    storage?: Storage,
    answers?: string[],
  ) => {
    const owner = `synthetic-${name}-human-owner-credential`;
    const registry = createRegistry();
    registry.install(
      createA2ATools({ self: name, config: async () => configs[name] }),
    );
    const node = await fixture({
      storage,
      registry,
      answers,
      tokensPerSecond: 100_000,
      ...(name === "beta"
        ? { fileArtifacts: options.targetFileArtifacts }
        : {}),
      mesh: { name, owner: { userId: `${name}-owner`, tenant: "" } },
      http: {
        authenticate: peerBearerAuth(() => owner, `${name}-owner`, {
          config: async () => configs[name],
        }),
      },
      clientHeaders: () => ({ Authorization: `Bearer ${owner}` }),
    });
    node.adapter.options.card.name = name;
    node.adapter.options.card.description = `${name} synthetic specialist`;
    node.adapter.options.card.skills[0].description =
      name === "beta"
        ? "Render precise synthetic charts from supplied numbers."
        : "Coordinate synthetic work.";
    return node;
  };
  let alpha = await make("alpha", options.sourceStorage, options.sourceAnswers);
  const beta = await make("beta", undefined, options.targetAnswers);
  configs.alpha.agents.beta = {
    url: beta.baseUrl,
    allowHttpLoopback: true,
    bearerTokenFile: outgoing,
    incomingBearerTokenFile: incoming,
  };
  configs.beta.agents.alpha = {
    url: alpha.baseUrl,
    allowHttpLoopback: true,
    bearerTokenFile: incoming,
    incomingBearerTokenFile: outgoing,
  };
  return {
    get alpha() {
      return alpha;
    },
    beta,
    configs,
    directory,
    outgoing,
    incoming,
    peerClient: () => configuredAgent("beta", configs.alpha),
    reopenSource: async (
      storage: () => Promise<Storage>,
      answers: string[],
    ) => {
      await alpha.close();
      alpha = await make("alpha", await storage(), answers);
      configs.beta.agents.alpha.url = alpha.baseUrl;
      return alpha;
    },
    close: async () => {
      await alpha.close();
      await beta.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
