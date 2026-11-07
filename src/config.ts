import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { connectAgent, endpoint, LocalA2AError, type ConnectionOptions } from "./client.ts";

export interface AgentTarget {
  url: string;
  allowHttpLoopback?: boolean;
  allowedOrigins?: string[];
  bearerTokenEnv?: string;
  bearerTokenFile?: string;
  /** Host-only credential reference authenticating this peer's incoming requests. Never part of discovery output. */
  incomingBearerTokenFile?: string;
}
export interface AgentConfig { agents: Record<string, AgentTarget> }
export async function defaultConfigPath() {
  if (process.env.PI_A2A_CONFIG !== undefined) return process.env.PI_A2A_CONFIG;
  const { CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");
  return join(homedir(), CONFIG_DIR_NAME, "a2a", "agents.json");
}
export async function readAgentConfig(file?: string): Promise<AgentConfig> {
  const explicit = file !== undefined || process.env.PI_A2A_CONFIG !== undefined;
  file ??= await defaultConfigPath();
  let text: string;
  try {
    if ((await stat(file)).size > 65_536) throw new Error();
    text = await readFile(file, "utf8");
  } catch (error) {
    if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return { agents: {} };
    throw new LocalA2AError("CONFIGURATION_UNREADABLE");
  }
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).join() !== "agents" || !value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new Error();
    for (const [name, target] of Object.entries(value.agents) as [string, AgentTarget][]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || !target || typeof target !== "object" || Array.isArray(target)) throw new Error();
      if (Object.keys(target).some(key => !["url", "allowHttpLoopback", "allowedOrigins", "bearerTokenEnv", "bearerTokenFile", "incomingBearerTokenFile"].includes(key))) throw new Error();
      if (typeof target.url !== "string" || (target.allowHttpLoopback !== undefined && typeof target.allowHttpLoopback !== "boolean")) throw new Error();
      endpoint(target.url, target.allowHttpLoopback);
      if (target.allowedOrigins !== undefined) {
        if (!Array.isArray(target.allowedOrigins)) throw new Error();
        target.allowedOrigins.forEach(url => endpoint(url, target.allowHttpLoopback));
      }
      if (target.bearerTokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(target.bearerTokenEnv)) throw new Error();
      if (target.bearerTokenFile !== undefined && (typeof target.bearerTokenFile !== "string" || !isAbsolute(target.bearerTokenFile) || target.bearerTokenEnv !== undefined)) throw new Error();
      if (target.incomingBearerTokenFile !== undefined && (typeof target.incomingBearerTokenFile !== "string" || !isAbsolute(target.incomingBearerTokenFile))) throw new Error();
    }
    return value;
  } catch { throw new LocalA2AError("INVALID_CONFIGURATION"); }
}
export async function credentialFile(file: string): Promise<string> {
  try {
    if ((await stat(file)).size > 16_384) throw new Error();
    const token = (await readFile(file, "utf8")).trim();
    if (!token || /[\r\n]/.test(token)) throw new Error();
    return token;
  } catch { throw new LocalA2AError("CREDENTIAL_MISSING"); }
}
export async function configuredAgent(name: string, config: AgentConfig, signal?: AbortSignal) {
  const target = Object.hasOwn(config.agents, name) ? structuredClone(config.agents[name]) : undefined;
  if (!target) throw new LocalA2AError("AGENT_NOT_CONFIGURED");
  const options: ConnectionOptions = {
    signal,
    allowHttpLoopback: target.allowHttpLoopback,
    allowedOrigins: target.allowedOrigins,
    headers: target.bearerTokenEnv || target.bearerTokenFile ? async () => {
      let token: string | undefined;
      try {
        if (target.bearerTokenFile) token = await credentialFile(target.bearerTokenFile);
        else token = process.env[target.bearerTokenEnv!];
      } catch { throw new LocalA2AError("CREDENTIAL_MISSING"); }
      if (!token || /[\r\n]/.test(token)) throw new LocalA2AError("CREDENTIAL_MISSING");
      return { Authorization: `Bearer ${token}` };
    } : undefined,
  };
  return connectAgent(target.url, options);
}
