import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

test("the extension loads on Node.js and registers its tools, command, and hooks", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    on(event: string) {
      events.push(event);
    },
  };

  // Only registration methods exist on the fake API: loading must not send
  // messages, append entries, or read configuration.
  extension(pi as unknown as ExtensionAPI);

  assert.deepEqual(tools, ["a2a_agents", "a2a_send", "a2a_get_task", "a2a_cancel_task"]);
  assert.deepEqual(commands, ["a2a"]);
  assert.deepEqual(events.sort(), ["agent_settled", "message_end", "session_shutdown", "session_start", "session_tree"]);
});
