import assert from "node:assert/strict";
import test from "node:test";
import { timingSafeEqual } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The distributable host-side example is plain JavaScript.
import { provisionPeers } from "../examples/mesh/provision.mjs";
import { readAgentConfig } from "../src/config.ts";

// The example protects credentials with POSIX file modes. Windows has no
// equivalent modes, so the example refuses to run there (tested below).
const posixOnly =
  process.platform === "win32" && "requires POSIX file permissions";

const equalFiles = async (left: string, right: string) => {
  const a = await readFile(left),
    b = await readFile(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

test(
  "peer provisioning is private, directional, idempotent and additive without rotating existing credentials",
  { skip: posixOnly },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "a2a-provision-"));
    t.after(() => rm(root, { recursive: true }));
    const directory = join(root, "directory.json"),
      output = join(root, "private");
    const agents: Record<string, { url: string }> = {
      alpha: { url: "https://alpha.example.invalid" },
      beta: { url: "https://beta.example.invalid" },
    };
    await writeFile(directory, JSON.stringify({ agents }));
    const first = await provisionPeers(directory, output, "/auth/a2a");
    assert.deepEqual(first, {
      agents: ["alpha", "beta"],
      directedPairs: 2,
      credentialsPrinted: false,
    });
    const sender = join(output, "alpha/beta.outgoing.token"),
      receiver = join(output, "beta/alpha.incoming.token");
    assert.equal(await equalFiles(sender, receiver), true);
    assert.equal(
      await equalFiles(sender, join(output, "beta/alpha.outgoing.token")),
      false,
    );
    assert.equal((await stat(sender)).mode & 0o777, 0o600);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    const retained = await readFile(sender),
      before = (await stat(sender)).mtimeMs;
    await provisionPeers(directory, output, "/auth/a2a");
    assert.equal((await stat(sender)).mtimeMs, before);
    assert.equal(timingSafeEqual(retained, await readFile(sender)), true);
    agents.gamma = { url: "https://gamma.example.invalid" };
    await writeFile(directory, JSON.stringify({ agents }));
    const next = await provisionPeers(directory, output, "/auth/a2a");
    assert.equal(next.directedPairs, 6);
    assert.equal(timingSafeEqual(retained, await readFile(sender)), true);
    const config = await readAgentConfig(join(output, "alpha/agents.json"));
    assert.deepEqual(Object.keys(config.agents).sort(), [
      "alpha",
      "beta",
      "gamma",
    ]);
    const gamma = config.agents.gamma;
    const alpha = config.agents.alpha;
    assert(gamma);
    assert(alpha);
    assert.equal(gamma.bearerTokenFile, "/auth/a2a/gamma.outgoing.token");
    assert.equal(
      gamma.incomingBearerTokenFile,
      "/auth/a2a/gamma.incoming.token",
    );
    assert.equal(alpha.bearerTokenFile, undefined);
    await unlink(receiver); // Synthetic interrupted provisioning: recover only from the validated retained counterpart.
    await provisionPeers(directory, output, "/auth/a2a");
    assert.equal(await equalFiles(sender, receiver), true);
    assert.equal(timingSafeEqual(retained, await readFile(sender)), true);
  },
);

test(
  "conflicting retained keys, inline credentials, unsafe modes and Git destinations fail without overwriting keys",
  { skip: posixOnly },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "a2a-provision-refusal-"));
    t.after(() => rm(root, { recursive: true }));
    const directory = join(root, "directory.json"),
      output = join(root, "private");
    const agents = {
      alpha: { url: "https://alpha.example.invalid" },
      beta: { url: "https://beta.example.invalid" },
    };
    await writeFile(directory, JSON.stringify({ agents }));
    await provisionPeers(directory, output, "/auth/a2a");
    const sender = join(output, "alpha/beta.outgoing.token"),
      receiver = join(output, "beta/alpha.incoming.token");
    const original = await readFile(sender);
    await writeFile(receiver, "f".repeat(64) + "\n");
    await assert.rejects(
      provisionPeers(directory, output, "/auth/a2a"),
      /conflict/,
    );
    assert.equal(timingSafeEqual(original, await readFile(sender)), true);
    const unsafe = join(root, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    await assert.rejects(
      provisionPeers(directory, unsafe, "/auth/a2a"),
      /Unsafe private/,
    );
    const repository = join(root, "repo");
    await mkdir(join(repository, ".git"), { recursive: true });
    await assert.rejects(
      provisionPeers(directory, join(repository, "credentials"), "/auth/a2a"),
      /outside Git/,
    );
    await writeFile(
      directory,
      JSON.stringify({
        agents: {
          ...agents,
          gamma: {
            url: "https://gamma.example.invalid",
            bearerTokenEnv: "UNUSED_SYNTHETIC",
          },
        },
      }),
    );
    await assert.rejects(
      provisionPeers(directory, join(root, "not-written"), "/auth/a2a"),
      /endpoints only/,
    );
  },
);

test(
  "peer provisioning fails closed where POSIX permissions are unavailable",
  { skip: process.platform !== "win32" && "Windows-only check" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "a2a-provision-"));
    t.after(() => rm(root, { recursive: true }));
    const directory = join(root, "directory.json"),
      output = join(root, "private");
    await writeFile(
      directory,
      JSON.stringify({
        agents: {
          alpha: { url: "https://alpha.example.invalid" },
          beta: { url: "https://beta.example.invalid" },
        },
      }),
    );
    await assert.rejects(
      provisionPeers(directory, output, "/auth/a2a"),
      /Unsafe private directory/,
    );
    await assert.rejects(stat(join(output, "alpha/beta.outgoing.token")), {
      code: "ENOENT",
    });
  },
);
