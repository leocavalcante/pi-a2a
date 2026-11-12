import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const dev = manifest.devDependencies;
const directory = mkdtempSync(join(tmpdir(), "pi-a2a-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const options = { encoding: "utf8", timeout: 180000, shell: process.platform === "win32" };
try {
  const output = execFileSync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], options);
  const records = JSON.parse(output);
  const packages = Array.isArray(records) ? records : Object.values(records);
  assert.equal(packages.length, 1);
  const packed = packages[0];
  const paths = packed.files.map(file => file.path);
  for (const required of [
    "src/extension.ts",
    "dist/client.js",
    "dist/client.d.ts",
    "dist/durable.js",
    "dist/durable.d.ts",
    "dist/server.js",
    "dist/server.d.ts",
    "examples/echo.ts",
    "CHANGELOG.md",
    "README.md",
    "LICENSE",
  ]) {
    assert(paths.includes(required), `Missing published file: ${required}`);
  }
  assert(!paths.some(path => /^(?:tests|node_modules|\.github|docs)\//.test(path)));
  assert(!paths.some(path => /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*)$/.test(path)));

  // Install like an SDK user, plus the host modules Pi provides to extensions.
  const consumer = join(directory, "consumer");
  execFileSync(npm, [
    "install", "--prefix", consumer, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
    join(directory, packed.filename),
    `@earendil-works/pi-durable@${dev["@earendil-works/pi-durable"]}`,
    `@earendil-works/chord@${dev["@earendil-works/chord"]}`,
    `typebox@${dev.typebox}`,
    `jiti@${dev.jiti}`,
  ], { ...options, stdio: "inherit" });
  const installed = JSON.parse(readFileSync(join(consumer, "node_modules/@leocavalcante/pi-a2a/package.json"), "utf8"));
  assert.equal(installed.version, manifest.version);

  const sdk = join(consumer, "sdk.mjs");
  writeFileSync(sdk, `
    import assert from "node:assert/strict";
    const client = await import("@leocavalcante/pi-a2a");
    assert.equal(typeof client.connectAgent, "function");
    assert.equal(typeof (await import("@leocavalcante/pi-a2a/client")).sendText, "function");
    assert.equal(typeof (await import("@leocavalcante/pi-a2a/server")).createA2AServer, "function");
    assert.equal(typeof (await import("@leocavalcante/pi-a2a/durable")).createDurableA2A, "function");
    console.log("Packed SDK entry points load under Node.js.");
  `);
  execFileSync(process.execPath, [sdk], { cwd: consumer, timeout: 30000, stdio: "inherit" });

  // Pi loads extension sources from installed packages through jiti.
  const extension = join(consumer, "extension.mjs");
  writeFileSync(extension, `
    import assert from "node:assert/strict";
    const loaded = await import("@leocavalcante/pi-a2a/extension");
    // jiti exposes TypeScript in node_modules through CommonJS interop; Pi unwraps it the same way.
    const register = typeof loaded.default === "function" ? loaded.default : loaded.default.default;
    assert.equal(typeof register, "function");
    const tools = [];
    register({ registerTool: tool => tools.push(tool.name), registerCommand() {}, on() {} });
    assert.deepEqual(tools, ["a2a_agents", "a2a_send", "a2a_get_task", "a2a_cancel_task"]);
    console.log("Packed extension loads under Node.js through jiti.");
  `);
  execFileSync(process.execPath, ["--import", "jiti/register", extension], { cwd: consumer, timeout: 30000, stdio: "inherit" });
  console.log(`Validated ${packed.filename}: ${paths.length} allowlisted files.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
