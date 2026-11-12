import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentCard } from "@a2a-js/sdk";
import { Value } from "typebox/value";
import {
  CONFIG_DIR_NAME,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { boundedText } from "../src/client.ts";
import {
  configuredAgent,
  defaultConfigPath,
  readAgentConfig,
} from "../src/config.ts";
import { registerA2A } from "../src/extension.ts";
import { card, fixture } from "./fixtures/agent.ts";

function mockPi() {
  const tools = new Map<string, ToolDefinition>();
  const entries: unknown[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand() {},
    on() {
      return () => {};
    },
    appendEntry: (customType: string, data: unknown) =>
      entries.push({ type: "custom", customType, data }),
  } as unknown as ExtensionAPI;
  const ctx = {
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionContext;
  return { pi, tools, entries, ctx };
}

test("Pi tool records message intent before networking and returns schema-valid structured data", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { pi, tools, entries, ctx } = mockPi();
  let connects = 0;
  registerA2A(pi, {
    loadConfig: async () => ({
      agents: { sample: { url: f.baseUrl, allowHttpLoopback: true } },
    }),
    connect: async () => {
      assert.ok(entries.length > 0);
      connects++;
      return f.client;
    },
  });
  assert.equal(connects, 0);
  const tool = tools.get("a2a_send")!;
  const value = await tool.execute(
    "call-1",
    { agent: "sample", message: "Hello", messageId: "pi-tool-1" },
    undefined,
    undefined,
    ctx as never,
  );
  assert.equal(value.isError, undefined);
  assert.ok(Value.Check(tool.outputSchema!, value.structuredContent));
  const data = value.structuredContent as {
    taskId: string;
    text: string;
    messageId: string;
  };
  assert.equal(data.messageId, "pi-tool-1");
  assert.equal(data.text, "Hello over A2A");
  assert.ok(data.taskId);
  const status = await tools
    .get("a2a_get_task")!
    .execute(
      "get-1",
      { agent: "sample", taskId: data.taskId },
      undefined,
      undefined,
      ctx as never,
    );
  assert.equal((status.structuredContent as { text: string }).text, data.text);
  assert.equal(f.faux.state.callCount, 1);
});

test("uncertain sends retain their ID and sanitize remote diagnostics", async () => {
  const { pi, tools, entries, ctx } = mockPi();
  registerA2A(pi, {
    loadConfig: async () => ({
      agents: { sample: { url: "https://example.invalid" } },
    }),
    connect: async () => {
      throw new Error("private diagnostic Bearer synthetic-secret");
    },
  });
  const tool = tools.get("a2a_send")!;
  const first = await tool.execute(
    "same-tool-call",
    { agent: "sample", message: "Hello" },
    undefined,
    undefined,
    ctx as never,
  );
  const second = await tool.execute(
    "same-tool-call",
    { agent: "sample", message: "Hello" },
    undefined,
    undefined,
    ctx as never,
  );
  assert.equal(first.isError, true);
  assert.ok(Value.Check(tool.outputSchema!, first.structuredContent));
  assert.equal(
    (first.structuredContent as { messageId: string }).messageId,
    (second.structuredContent as { messageId: string }).messageId,
  );
  assert.ok(!JSON.stringify(first).includes("synthetic-secret"));
  assert.ok(entries.length >= 2);
});

test("listing configured agents performs no discovery or model calls", async () => {
  const { pi, tools, ctx } = mockPi();
  registerA2A(pi, {
    loadConfig: async () => ({
      agents: { sample: { url: "https://example.invalid" } },
    }),
    connect: async () => {
      throw new Error("No connection expected");
    },
  });
  const value = await tools
    .get("a2a_agents")!
    .execute("list", {}, undefined, undefined, ctx as never);
  assert.deepEqual((value.structuredContent as { agents: string[] }).agents, [
    "sample",
  ]);
});

test("configuration defaults to Pi's a2a directory and honors PI_A2A_CONFIG", async (t) => {
  const previous = process.env.PI_A2A_CONFIG;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_A2A_CONFIG;
    else process.env.PI_A2A_CONFIG = previous;
  });
  delete process.env.PI_A2A_CONFIG;
  assert.equal(
    await defaultConfigPath(),
    join(homedir(), CONFIG_DIR_NAME, "a2a", "agents.json"),
  );

  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-config-path-"));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, "agents.json");
  const config = { agents: { sample: { url: "https://example.invalid" } } };
  await writeFile(file, JSON.stringify(config));
  process.env.PI_A2A_CONFIG = file;
  assert.equal(await defaultConfigPath(), file);
  assert.deepEqual(await readAgentConfig(), config);
});

test("configuration permits only explicit targets and environment credential references", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-config-"));
  t.after(() => rm(dir, { recursive: true }));
  const file = join(dir, "agents.json");
  await assert.rejects(readAgentConfig(file), /Configuration|configuration/);
  await writeFile(
    file,
    JSON.stringify({
      agents: {
        sample: {
          url: "https://example.invalid",
          bearerTokenEnv: "SYNTHETIC_A2A_CREDENTIAL",
        },
      },
    }),
  );
  assert.ok((await readAgentConfig(file)).agents.sample);
  await writeFile(
    file,
    JSON.stringify({
      agents: {
        sample: {
          url: "https://example.invalid",
          token: "Do not accept literal credentials",
        },
      },
    }),
  );
  await assert.rejects(readAgentConfig(file), /Invalid A2A configuration/);
  await writeFile(
    file,
    JSON.stringify({ agents: { sample: { url: "http://127.0.0.1:1234" } } }),
  );
  await assert.rejects(readAgentConfig(file), /Invalid A2A configuration/);
});

test("a private credential file authenticates requests without environment export", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-file-auth-"));
  t.after(() => rm(dir, { recursive: true }));
  const credential = join(dir, "credential");
  await writeFile(credential, "synthetic-file-credential\n", { mode: 0o600 });
  let received = "";
  const server = createServer((request, response) => {
    received = request.headers.authorization ?? "";
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        AgentCard.toJSON(card(`http://${request.headers.host}/a2a`)),
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await configuredAgent("sample", {
    agents: {
      sample: {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        allowHttpLoopback: true,
        bearerTokenFile: credential,
      },
    },
  });
  assert.equal(received, "Bearer synthetic-file-credential");
  assert.equal(Object.hasOwn(process.env, "PI_A2A_TEST_FILE_AUTH"), false);
});

test("Unicode and JSON-escaped tool output stays bounded and remains valid data", () => {
  for (const text of ["😀".repeat(20_000), '\u0000"\n'.repeat(20_000)]) {
    const value = boundedText(text);
    assert.ok(value.truncated);
    assert.ok(Buffer.byteLength(JSON.stringify(value.text)) <= 32_768);
    assert.ok(!value.text.includes("\ufffd"));
    assert.equal(JSON.parse(JSON.stringify(value.text)), value.text);
  }
});

async function sdkSession(
  dir: string,
  factory: (pi: ExtensionAPI) => void,
  script: ReturnType<typeof fauxAssistantMessage>[],
  manager = SessionManager.inMemory(dir),
) {
  const faux = fauxProvider();
  faux.setResponses(script);
  const runtime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(dir, "models-cache.json"),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [factory],
  });
  await loader.reload();
  const session = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    noTools: "builtin",
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
  });
  assert.equal(session.extensionsResult.errors.length, 0);
  return { ...session, faux };
}

test("a real Pi SDK session executes the extension tool through A2A to Durable", async (t) => {
  const f = await fixture({ answers: ["Durable reply"] });
  t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-sdk-"));
  t.after(() => rm(dir, { recursive: true }));
  const { session, faux } = await sdkSession(
    dir,
    (pi) =>
      registerA2A(pi, {
        loadConfig: async () => ({
          agents: { sample: { url: f.baseUrl, allowHttpLoopback: true } },
        }),
      }),
    [
      fauxAssistantMessage(
        [
          fauxToolCall("a2a_send", {
            agent: "sample",
            message: "Synthetic request",
            messageId: "sdk-tool-message",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Finished")]),
    ],
  );
  try {
    await session.prompt(
      "Send this synthetic request to the configured sample agent.",
    );
    const replies = session.messages.filter(
      (message) =>
        message.role === "toolResult" && message.toolName === "a2a_send",
    );
    assert.equal(replies.length, 1);
    const reply = replies[0];
    assert.equal(reply.role, "toolResult");
    if (reply.role === "toolResult") {
      assert.equal(reply.isError, false);
      assert.match(JSON.stringify(reply.content), /Durable reply/);
    }
    assert.equal(session.getLastAssistantText(), "Finished");
    assert.equal(faux.state.callCount, 2);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    session.dispose();
  }
});

test("the /a2a command sends without invoking a Pi-session model", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-command-"));
  t.after(() => rm(dir, { recursive: true }));
  const { session, faux } = await sdkSession(
    dir,
    (pi) =>
      registerA2A(pi, {
        loadConfig: async () => ({
          agents: { sample: { url: f.baseUrl, allowHttpLoopback: true } },
        }),
      }),
    [],
  );
  try {
    await session.prompt("/a2a send sample A synthetic command request");
    assert.equal(faux.state.callCount, 0);
    assert.equal(f.faux.state.callCount, 1);
    assert.match(JSON.stringify(session.messages), /Hello over A2A/);
  } finally {
    session.dispose();
  }
});

test("fresh command-only TUI receipts are not written to disk by Pi 1.5.0", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const dir = await mkdtemp(join(tmpdir(), "pi-a2a-command-persistence-"));
  t.after(() => rm(dir, { recursive: true }));
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const file = manager.getSessionFile()!;
  let checkedIntent = false;
  const { session, faux } = await sdkSession(
    dir,
    (pi) =>
      registerA2A(pi, {
        loadConfig: async () => ({
          agents: { sample: { url: f.baseUrl, allowHttpLoopback: true } },
        }),
        connect: async () => {
          assert.ok(
            manager
              .getBranch()
              .some(
                (entry) =>
                  entry.type === "custom" &&
                  entry.customType === "pi-a2a.receipt",
              ),
          );
          await assert.rejects(access(file), { code: "ENOENT" });
          checkedIntent = true;
          return f.client;
        },
      }),
    [],
    manager,
  );
  try {
    await session.bindExtensions({ mode: "tui" });
    await session.prompt(
      "/a2a send sample A synthetic command-only persistence check",
    );
    assert.equal(checkedIntent, true);
    assert.equal(faux.state.callCount, 0);
    assert.ok(
      manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "pi-a2a",
        ),
    );
    // appendEntry/sendMessage only changed memory: this history cannot be reopened after exit.
    await assert.rejects(access(file), { code: "ENOENT" });
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
});

export { sdkSession };
