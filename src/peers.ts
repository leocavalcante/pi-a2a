import { timingSafeEqual } from "node:crypto";
import type { AgentCard } from "@a2a-js/sdk";
import { boundedText, LocalA2AError, safeError } from "./client.ts";
import { configuredAgent, credentialFile, readAgentConfig, type AgentConfig } from "./config.ts";
import type { HttpOptions } from "./server.ts";

const validName = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
export function peerName(identity: string): string | undefined {
  return identity.startsWith("peer:") && validName(identity.slice(5)) ? identity.slice(5) : undefined;
}

/** Separate peer identities, not another copy of the human owner's credential. */
export function peerBearerAuth(readOwnerToken: () => string | undefined, owner = "owner",
  options: { config?: () => Promise<AgentConfig> } = {}): HttpOptions["authenticate"] {
  const config = options.config ?? readAgentConfig;
  return async request => {
    const received = request.headers.authorization;
    if (!received || received.length > 16_384) return undefined;
    const match = (token: string) => {
      const left = Buffer.from(`Bearer ${token}`), right = Buffer.from(received);
      return left.length === right.length && timingSafeEqual(left, right);
    };
    const own = readOwnerToken();
    if (!own || /[\r\n]/.test(own)) return undefined;
    if (match(own)) return owner;
    const entries = Object.entries((await config()).agents).filter(([, target]) => target.incomingBearerTokenFile);
    const peers = await Promise.all(entries.map(async ([name, target]) => ({ name, token: await credentialFile(target.incomingBearerTokenFile!) })));
    const matches = peers.filter(value => validName(value.name) && value.token.length >= 16 && value.token !== own && match(value.token));
    return matches.length === 1 ? `peer:${matches[0].name}` : undefined;
  };
}

/** Scan declared messaging credential values without exposing the directory or its credential references. */
export async function guardPeerData(value: unknown, config: AgentConfig): Promise<void> {
  const serialized = JSON.stringify(value) ?? "";
  for (const target of Object.values(config.agents)) {
    const tokens: string[] = [];
    if (target.bearerTokenFile) tokens.push(await credentialFile(target.bearerTokenFile));
    if (target.incomingBearerTokenFile) tokens.push(await credentialFile(target.incomingBearerTokenFile));
    if (target.bearerTokenEnv) {
      const token = process.env[target.bearerTokenEnv];
      if (!token || /[\r\n]/.test(token)) throw new LocalA2AError("CREDENTIAL_MISSING");
      tokens.push(token);
    }
    if (tokens.some(token => serialized.includes(token))) throw new LocalA2AError("SENSITIVE_CONTENT");
  }
}

export interface PeerDescription {
  agent: string;
  name?: string;
  description?: string;
  version?: string;
  inputModes?: string[];
  outputModes?: string[];
  streaming?: boolean;
  pushNotifications?: boolean;
  skills?: { id: string; name: string; description: string; tags: string[] }[];
  truncated?: boolean;
  error?: { code: string; message: string };
}
function describe(agent: string, card: AgentCard): PeerDescription {
  let truncated = false;
  const trim = (value: string, bytes: number) => {
    const bounded = boundedText(value, bytes); truncated ||= bounded.truncated; return bounded.text;
  };
  const modes = (values: string[]) => { truncated ||= values.length > 32; return values.slice(0, 32).map(value => trim(value, 128)); };
  const skills = card.skills.slice(0, 32).map(skill => ({ id: trim(skill.id, 128), name: trim(skill.name, 256),
    description: trim(skill.description, 1024), tags: skill.tags.slice(0, 16).map(tag => trim(tag, 128)) }));
  truncated ||= card.skills.length > skills.length || card.skills.some(skill => skill.tags.length > 16);
  const result: PeerDescription = { agent, name: trim(card.name, 256), description: trim(card.description, 2048), version: trim(card.version, 128),
    inputModes: modes(card.defaultInputModes), outputModes: modes(card.defaultOutputModes), streaming: Boolean(card.capabilities?.streaming),
    pushNotifications: Boolean(card.capabilities?.pushNotifications), skills };
  while (Buffer.byteLength(JSON.stringify(result)) > 8192 && skills.length) { skills.pop(); truncated = true; }
  while (Buffer.byteLength(JSON.stringify(result)) > 8192 && (result.inputModes!.length || result.outputModes!.length)) {
    (result.inputModes!.length > result.outputModes!.length ? result.inputModes! : result.outputModes!).pop(); truncated = true;
  }
  return { ...result, truncated };
}

/** Discover live Agent Cards from registered endpoints, never network scans or credentials supplied by a card. */
export async function discoverAgents(config: AgentConfig, options: { self?: string; offset?: number; limit?: number; signal?: AbortSignal } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new LocalA2AError("INVALID_CONFIGURATION");
  const names = Object.keys(config.agents).filter(name => name !== options.self).sort();
  const page = await Promise.all(names.slice(offset, offset + limit).map(async agent => {
    try {
      const client = await configuredAgent(agent, config, options.signal);
      return describe(agent, await client.getAgentCard({ signal: options.signal }));
    } catch (error) { return { agent, error: safeError(error) } as PeerDescription; }
  }));
  const agents: PeerDescription[] = [];
  for (const value of page) {
    if (agents.length && Buffer.byteLength(JSON.stringify([...agents, value])) > 30_000) break;
    agents.push(value);
  }
  return { agents, total: names.length, ...(offset + agents.length < names.length ? { nextOffset: offset + agents.length } : {}) };
}
