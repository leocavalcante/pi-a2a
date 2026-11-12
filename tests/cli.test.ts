import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { waitForTask } from "../src/client.ts";
import { fixture } from "./fixtures/agent.ts";
const exec = promisify(execFile);
const cli = process.env.A2A_CLI_BIN;

test(
  "official A2A CLI discovers, sends, retrieves and retries a Durable task",
  { skip: !cli && "Set A2A_CLI_BIN to run the official CLI integration" },
  async (t) => {
    const f = await fixture({ answers: ["Official CLI answer"] });
    t.after(f.close);
    const dir = await mkdtemp(join(tmpdir(), "a2a-official-cli-"));
    t.after(() => rm(dir, { recursive: true }));
    const run = (...args: string[]) =>
      exec(
        cli!,
        [
          "--agent-card",
          f.baseUrl,
          "--transport",
          "jsonrpc",
          "-o",
          "json",
          ...args,
        ],
        {
          cwd: dir,
          env: { HOME: dir, XDG_CONFIG_HOME: dir, PATH: process.env.PATH },
          timeout: 10000,
        },
      );
    assert.equal(
      JSON.parse((await run("card", "get")).stdout).name,
      "Test agent",
    );
    const file = join(dir, "request.json");
    await writeFile(
      file,
      JSON.stringify({
        message: {
          messageId: "official-cli-id",
          role: "ROLE_USER",
          parts: [{ text: "Literal R$800\n$(not-executed)" }],
        },
        configuration: { returnImmediately: true },
      }),
    );
    const admitted = JSON.parse(
      (await run("send", "--request-payload", file)).stdout,
    ).task;
    assert.ok(admitted.id);
    await waitForTask(f.client, admitted.id, { intervalMs: 10 });
    const retained = JSON.parse(
      (await run("task", "get", admitted.id)).stdout,
    ).task;
    assert.equal(retained.artifacts[0].parts[0].text, "Official CLI answer");
    assert.equal(
      JSON.parse((await run("send", "--request-payload", file)).stdout).task.id,
      admitted.id,
    );
    await writeFile(
      file,
      JSON.stringify({
        message: {
          messageId: "official-cli-id",
          role: "ROLE_USER",
          parts: [{ text: "Changed" }],
        },
      }),
    );
    await assert.rejects(run("send", "--request-payload", file));
    assert.equal(f.faux.state.callCount, 1);
  },
);

test(
  "official CLI streaming receives committed final text from Durable",
  { skip: !cli && "Set A2A_CLI_BIN to run the official CLI integration" },
  async (t) => {
    const f = await fixture({
      answers: ["Streamed official CLI answer"],
      tokensPerSecond: 100,
    });
    t.after(f.close);
    const dir = await mkdtemp(join(tmpdir(), "a2a-official-stream-"));
    t.after(() => rm(dir, { recursive: true }));
    const output = await exec(
      cli!,
      [
        "send",
        "--agent-card",
        f.baseUrl,
        "--transport",
        "jsonrpc",
        "--stream",
        "--output",
        "jsonl",
        "Synthetic streamed request",
      ],
      {
        cwd: dir,
        env: { HOME: dir, XDG_CONFIG_HOME: dir, PATH: process.env.PATH },
        timeout: 10000,
      },
    );
    assert.match(output.stdout, /Streamed official CLI answer/);
    assert.match(output.stdout, /TASK_STATE_COMPLETED/);
    assert.equal(f.faux.state.callCount, 1);
  },
);
