import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Message, Task, taskStateToJSON, type Client, type Message as A2AMessage, type Task as A2ATask } from "./client.ts";
import { boundedText, isTask, LocalA2AError, newMessageId, safeError, sendText, textOf, waitForTask } from "./client.ts";
import { configuredAgent, readAgentConfig, type AgentConfig } from "./config.ts";

const Output = Type.Object({
  ok: Type.Boolean(), agent: Type.Optional(Type.String()), agents: Type.Optional(Type.Array(Type.String())),
  messageId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()), contextId: Type.Optional(Type.String()),
  state: Type.Optional(Type.String()), text: Type.Optional(Type.String()), truncated: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
}, { additionalProperties: false });
type Reply = { ok: boolean; agent?: string; agents?: string[]; messageId?: string; taskId?: string; contextId?: string; state?: string; text?: string; truncated?: boolean; error?: { code: string; message: string } };
interface Receipt { agent: string; endpoint: string; messageId: string; taskId?: string; contextId?: string; toolCallId: string }
const kind = "pi-a2a.receipt";
function receipts(ctx: ExtensionContext): Receipt[] {
  return ctx.sessionManager.getBranch().flatMap(entry => entry.type === "custom" && entry.customType === kind ? [entry.data as Receipt] : []);
}
function summarize(agent: string, value: A2AMessage | A2ATask, messageId?: string): Reply {
  if (Buffer.byteLength(value.contextId) > 1024 || (isTask(value) && (!value.id || Buffer.byteLength(value.id) > 1024))) throw new Error("Invalid remote task identity.");
  const { text, truncated } = boundedText(textOf(value));
  return {
    ok: true, agent, ...(messageId ? { messageId } : {}), contextId: value.contextId,
    ...(isTask(value) ? { taskId: value.id, state: taskStateToJSON(value.status?.state ?? 0) } : { state: "MESSAGE" }),
    text, truncated,
  };
}
const result = (value: Reply) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value, structuredContent: value, ...(value.ok ? {} : { isError: true }),
});

export interface ExtensionOptions {
  loadConfig?: () => Promise<AgentConfig>;
  connect?: (name: string, config: AgentConfig) => Promise<Client>;
}
/** Exported factory makes tool execution testable without invoking a real model. */
export function registerA2A(pi: ExtensionAPI, options: ExtensionOptions = {}) {
  const load = options.loadConfig ?? readAgentConfig;
  const connect = options.connect ?? configuredAgent;
  const send = async (agent: string, text: string, requestedId: string | undefined, contextId: string | undefined, taskId: string | undefined,
    wait: boolean, callId: string, ctx: ExtensionContext, signal?: AbortSignal, update?: (value: ReturnType<typeof result>) => void): Promise<Reply> => {
    let receipt: Receipt | undefined;
    try {
      const config = await load();
      if (!Object.hasOwn(config.agents, agent)) throw new LocalA2AError("AGENT_NOT_CONFIGURED");
      const endpoint = createHash("sha256").update(config.agents[agent].url).digest("hex");
      const known = receipts(ctx).filter(item => item.agent === agent && item.endpoint === endpoint);
      const old = known.findLast(item => item.toolCallId === callId);
      const messageId = requestedId ?? old?.messageId ?? newMessageId();
      const activeContext = contextId ?? (taskId ? undefined : known.findLast(item => item.contextId)?.contextId);
      receipt = { agent, endpoint, messageId, toolCallId: callId, ...(activeContext ? { contextId: activeContext } : {}), ...(taskId ? { taskId } : {}) };
      // Persist intent BEFORE even discovery/network I/O. Do not capture the session transcript or credentials.
      pi.appendEntry(kind, receipt);
      update?.(result({ ok: true, agent, messageId, state: "SENDING" }));
      const client = await connect(agent, config);
      let value = await sendText(client, text, { messageId, contextId: activeContext, taskId, signal, returnImmediately: true });
      if (isTask(value)) {
        receipt = { ...receipt, taskId: value.id, contextId: value.contextId };
        pi.appendEntry(kind, receipt);
        if (wait) value = await waitForTask(client, value.id, { signal, onUpdate: task => update?.(result(summarize(agent, task, messageId))) });
      }
      return summarize(agent, value, messageId);
    } catch (error) {
      return { ok: false, agent, ...(receipt ? { messageId: receipt.messageId, ...(receipt.taskId ? { taskId: receipt.taskId } : {}), ...(receipt.contextId ? { contextId: receipt.contextId } : {}) } : {}), error: safeError(error) };
    }
  };
  pi.registerTool({
    name: "a2a_agents", label: "A2A agents", description: "List explicitly configured A2A agent names. Does not scan the network or send session context.",
    parameters: Type.Object({}), outputSchema: Output,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute() {
      try { return result({ ok: true, agents: Object.keys((await load()).agents) }); }
      catch (error) { return result({ ok: false, error: safeError(error) }); }
    },
  });
  pi.registerTool({
    name: "a2a_send", label: "A2A send", description: "Send authorized text to a configured A2A agent. Retain messageId/taskId for recovery. Output text is capped at 32 KiB; non-text artifacts are not downloaded.",
    promptSnippet: "Send a message to an explicitly configured remote agent",
    promptGuidelines: [
      "Use a2a_send only for authorized delegation to a configured agent; send only the needed context, never the full session automatically.",
      "With a2a_send, retain the messageId/taskId. An interrupted wait does not cancel remote work; use a2a_get_task instead of resubmitting with a new ID.",
      "a2a_send grants no extra authority to publish, pay, contact people, move private data, or approve a remote agent's request.",
    ],
    parameters: Type.Object({ agent: Type.String(), message: Type.String(), messageId: Type.Optional(Type.String()), contextId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()), wait: Type.Optional(Type.Boolean()) }), outputSchema: Output,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(id, params, signal, onUpdate, ctx) {
      return result(await send(params.agent, params.message, params.messageId, params.contextId, params.taskId, params.wait ?? true, id, ctx, signal, onUpdate));
    },
  });
  pi.registerTool({
    name: "a2a_get_task", label: "A2A task", description: "Retrieve an existing A2A task without submitting work. Optionally wait until it completes or requires input/auth. Text is capped at 32 KiB.",
    parameters: Type.Object({ agent: Type.String(), taskId: Type.String(), wait: Type.Optional(Type.Boolean()) }), outputSchema: Output,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    async execute(_id, params, signal, onUpdate) {
      try {
        const client = await connect(params.agent, await load());
        const value = params.wait ? await waitForTask(client, params.taskId, { signal, onUpdate: task => onUpdate?.(result(summarize(params.agent, task))) }) : await client.getTask({ id: params.taskId, tenant: "", historyLength: 0 }, { signal });
        return result(summarize(params.agent, value));
      } catch (error) { return result({ ok: false, agent: params.agent, taskId: params.taskId, error: safeError(error) }); }
    },
  });
  pi.registerTool({
    name: "a2a_cancel_task", label: "A2A cancel", description: "Explicitly request remote task cancellation. This can have partial effects and may be rejected as not cancelable. Never use just because local waiting was interrupted.",
    parameters: Type.Object({ agent: Type.String(), taskId: Type.String() }), outputSchema: Output,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, params, signal) {
      try {
        const client = await connect(params.agent, await load());
        return result(summarize(params.agent, await client.cancelTask({ id: params.taskId, tenant: "", metadata: undefined }, { signal })));
      } catch (error) { return result({ ok: false, agent: params.agent, taskId: params.taskId, error: safeError(error) }); }
    },
  });
  pi.registerCommand("a2a", {
    description: "A2A: list | send AGENT MESSAGE | result AGENT TASK_ID | cancel AGENT TASK_ID",
    handler: async (args, ctx) => {
      const match = /^(\S+)(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim());
      let reply: Reply;
      try {
        const operation = match?.[1] ?? "list", agent = match?.[2], rest = match?.[3];
        if (operation === "list") reply = { ok: true, agents: Object.keys((await load()).agents) };
        else if (operation === "send" && agent && rest) reply = await send(agent, rest, undefined, undefined, undefined, true, newMessageId(), ctx);
        else if ((operation === "result" || operation === "cancel") && agent && rest) {
          const client = await connect(agent, await load());
          const value = operation === "result" ? await client.getTask({ id: rest, tenant: "", historyLength: 0 }) : await client.cancelTask({ id: rest, tenant: "", metadata: undefined });
          reply = summarize(agent, value);
        } else throw new Error("Invalid A2A command.");
      } catch (error) { reply = { ok: false, error: safeError(error) }; }
      pi.sendMessage({ customType: "pi-a2a", content: JSON.stringify(reply), display: true, details: reply }, { triggerTurn: false });
    },
  });
}

export default function a2aExtension(pi: ExtensionAPI) { registerA2A(pi); }
