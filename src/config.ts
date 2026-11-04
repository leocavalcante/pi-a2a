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
}
export interface AgentConfig { agents: Record<string, AgentTarget> }
export const defaultConfigPath = () => process.env.PI_A2A_CONFIG ?? join(homedir(), ".config", "pi-a2a", "agents.json");
export async function readAgentConfig(file = defaultConfigPath()): Promise<AgentConfig> {
  let text: string;
  try {
    if ((await stat(file)).size > 65_536) throw new Error();
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { agents: {} };
    throw new LocalA2AError("CONFIGURATION_UNREADABLE");
  }
  try {
    const value = JSON.parse(text);
    if (!value || Object.keys(value).join() !== "agents" || !value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new Error();
    for (const [name, target] of Object.entries(value.agents) as [string, AgentTarget][]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || !target || typeof target !== "object" || Array.isArray(target)) throw new Error();
      if (Object.keys(target).some(key => !["url", "allowHttpLoopback", "allowedOrigins", "bearerTokenEnv", "bearerTokenFile"].includes(key))) throw new Error();
      if (typeof target.url !== "string" || (target.allowHttpLoopback !== undefined && typeof target.allowHttpLoopback !== "boolean")) throw new Error();
      endpoint(target.url, target.allowHttpLoopback);
      if (target.allowedOrigins !== undefined) {
        if (!Array.isArray(target.allowedOrigins)) throw new Error();
        target.allowedOrigins.forEach(url => endpoint(url, target.allowHttpLoopback));
      }
      if (target.bearerTokenEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(target.bearerTokenEnv)) throw new Error();
      if (target.bearerTokenFile !== undefined && (typeof target.bearerTokenFile !== "string" || !isAbsolute(target.bearerTokenFile) || target.bearerTokenEnv !== undefined)) throw new Error();
    }
    return value;
  } catch { throw new LocalA2AError("INVALID_CONFIGURATION"); }
}
export async function configuredAgent(name: string, config: AgentConfig) {
  const target = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
  if (!target) throw new LocalA2AError("AGENT_NOT_CONFIGURED");
  const options: ConnectionOptions = {
    allowHttpLoopback: target.allowHttpLoopback,
    allowedOrigins: target.allowedOrigins,
    headers: target.bearerTokenEnv || target.bearerTokenFile ? async () => {
      let token: string | undefined;
      try {
        if (target.bearerTokenFile) {
          if ((await stat(target.bearerTokenFile)).size > 16_384) throw new Error();
          token = (await readFile(target.bearerTokenFile, "utf8")).trim();
        } else token = process.env[target.bearerTokenEnv!];
      } catch { throw new LocalA2AError("CREDENTIAL_MISSING"); }
      if (!token || /[\r\n]/.test(token)) throw new LocalA2AError("CREDENTIAL_MISSING");
      return { Authorization: `Bearer ${token}` };
    } : undefined,
  };
  return connectAgent(target.url, options);
}
