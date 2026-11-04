import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { configuredAgent, readAgentConfig, type AgentConfig } from "./config.ts";
import { boundedText, isTask, sendText, safeError, textOf, waitForTask, taskStateToJSON } from "./client.ts";

const parameters = {
  type: "object", additionalProperties: false, required: ["agent", "message"],
  properties: { agent: { type: "string" }, message: { type: "string" }, messageId: { type: "string" }, contextId: { type: "string" }, taskId: { type: "string" } },
} as const;
const taskParameters = { type: "object", additionalProperties: false, required: ["agent", "taskId"], properties: { agent: { type: "string" }, taskId: { type: "string" } } } as const;
const outputSchema = { type: "object", required: ["agent"], properties: {
  agent: { type: "string" }, messageId: { type: "string" }, taskId: { type: "string" }, contextId: { type: "string" },
  state: { type: "string" }, text: { type: "string" }, truncated: { type: "boolean" },
  error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } },
}, additionalProperties: false } as const;

/** Outbound delegation is deliberately NOT replay-safe: arbitrary A2A peers need not deduplicate message IDs. */
export function createA2ATools(options: { config?: () => Promise<AgentConfig> } = {}) {
  const config = options.config ?? readAgentConfig;
  return defineExtension({
    name: "pi-a2a",
    tools: [
      defineTool({
        name: "a2a_send", description: "Send authorized text to a configured A2A agent. Do not automatically forward private context or treat delegation as approval for external effects. Interrupted waits do not cancel remote work.",
        parameters, structuredOutputSchema: outputSchema,
        execute: async (raw, api, context) => {
          const args = raw as { agent: string; message: string; messageId?: string; contextId?: string; taskId?: string };
          const messageId = args.messageId ?? `a2a-${api.taskId}`;
          await api.details({ agent: args.agent, messageId }, context);
          let taskId: string | undefined;
          try {
            const client = await configuredAgent(args.agent, await config());
            let value = await sendText(client, args.message, { messageId, contextId: args.contextId, taskId: args.taskId, signal: context.abortSignal });
            if (isTask(value)) {
              taskId = value.id;
              await api.details({ agent: args.agent, messageId, taskId, contextId: value.contextId }, context);
              value = await waitForTask(client, taskId, { signal: context.abortSignal });
            }
            const result = { agent: args.agent, messageId, ...(taskId ? { taskId } : {}), contextId: value.contextId,
              state: isTask(value) ? taskStateToJSON(value.status?.state ?? 0) : "MESSAGE", ...boundedText(textOf(value)) };
            return { output: [{ type: "text", text: JSON.stringify(result) }], structuredOutput: result, details: result };
          } catch (error) {
            const result = { agent: args.agent, messageId, ...(taskId ? { taskId } : {}), error: safeError(error) };
            return { isError: true, output: [{ type: "text", text: JSON.stringify(result) }], structuredOutput: result, details: result };
          }
        },
      }),
      defineTool({
        name: "a2a_get_task", description: "Retrieve a retained A2A task without submitting another message. Output is bounded to 32 KiB.",
        replay: "safe", parameters: taskParameters, structuredOutputSchema: outputSchema,
        execute: async (raw, _api, context) => {
          const args = raw as { agent: string; taskId: string };
          try {
            const client = await configuredAgent(args.agent, await config());
            const task = await client.getTask({ id: args.taskId, tenant: "", historyLength: 0 }, { signal: context.abortSignal });
            const value = { agent: args.agent, taskId: task.id, contextId: task.contextId, state: taskStateToJSON(task.status?.state ?? 0), ...boundedText(textOf(task)) };
            return { output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value, details: value };
          } catch (error) {
            const value = { agent: args.agent, taskId: args.taskId, error: safeError(error) };
            return { isError: true, output: [{ type: "text", text: JSON.stringify(value) }], structuredOutput: value, details: value };
          }
        },
      }),
    ],
  });
}
