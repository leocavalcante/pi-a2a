import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface PackageManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines?: { pi?: string };
}

const manifest = JSON.parse(
  readFileSync("package.json", "utf8"),
) as PackageManifest;

// "min" reads the minimum supported Pi from `engines.pi` (for example ">=1.1.0"),
// so the shared CI workflow needs no repository-specific version.
let requested = process.argv[2];
if (requested === "min") {
  const minimum = /^>=\s*(\d+\.\d+\.\d+)$/.exec(
    manifest.engines?.pi ?? "",
  )?.[1];
  if (!minimum) {
    throw new Error('Declare the minimum Pi as engines.pi ">=x.y.z".');
  }
  requested = minimum;
}
if (!requested || !/^(?:latest|\d+\.\d+\.\d+)$/.test(requested)) {
  throw new Error("Expected min, latest, or a stable Pi version.");
}

let version = requested;
if (requested === "latest") {
  const response = await fetch(
    "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
    {
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`Registry returned ${String(response.status)}`);
  const metadata = (await response.json()) as { version: string };
  version = metadata.version;
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Expected a stable Pi version.");
}

for (const [name] of Object.entries(manifest.devDependencies)) {
  if (name.startsWith("@earendil-works/"))
    manifest.devDependencies[name] = version;
}
// An older Pi can resolve dependencies it no longer works with. A repository
// pins what each Pi release needs in .github/scripts/pi-pins.json, for example
// { "1.0.4": { "@earendil-works/pi-codemode": "1.1.0" } }.
const pinsFile = new URL("pi-pins.json", import.meta.url);
if (existsSync(pinsFile)) {
  const pins = JSON.parse(readFileSync(pinsFile, "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  Object.assign(manifest.devDependencies, pins[version] ?? {});
}
// Keep runtime dependencies pinned: test the Pi version consumers use with the
// runtime dependencies this package ships.
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
