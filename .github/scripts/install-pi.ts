import {
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requested = process.argv[2];
if (!requested || !/^(?:latest|\d+\.\d+\.\d+)$/.test(requested)) {
  throw new Error("Expected a stable Pi version or latest.");
}

let version = requested;
if (requested === "latest") {
  const response = await fetch(
    "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
    {
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error(`Registry returned ${response.status}`);
  const metadata = (await response.json()) as { version: string };
  version = metadata.version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Expected a stable Pi version.");
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name] of Object.entries(manifest.devDependencies)) {
  if (name.startsWith("@earendil-works/"))
    manifest.devDependencies[name] = version;
}
// Keep runtime dependencies pinned: test the requested Pi SDK against the
// runtime dependencies this package actually ships.
const directory = mkdtempSync(join(tmpdir(), "pi-sdk-"));
try {
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
      trustedDependencies: [],
    }),
  );
  const result = Bun.spawnSync(
    [process.execPath, "install", "--ignore-scripts", "--cwd", directory],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (result.exitCode !== 0)
    throw new Error("Failed to install the compatibility SDK.");
  rmSync("node_modules", { recursive: true, force: true });
  renameSync(join(directory, "node_modules"), "node_modules");
  console.log(
    `Testing Pi ${version} with its fresh dependency closure; repository manifest and lockfile unchanged.`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
