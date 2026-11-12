// Host-side provisioning only. Never run this against a live provider credential store.
import { randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgentConfig } from "../../dist/config.js";

async function privateDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe private directory.");
}
async function existingToken(file) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.size > 100 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Unsafe credential file.");
  const value = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid retained credential.");
  return value;
}
async function saveConfig(file, value) {
  let existing;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error("Unsafe configuration file.");
    existing = await readAgentConfig(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && JSON.stringify(existing) === JSON.stringify(value)) return;
  const temporary = `${file}.pending-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/** Add registered peers idempotently, preserving every existing pair credential. No values are returned. */
export async function provisionPeers(directoryFile, outputRoot, runtimeRoot) {
  if (!isAbsolute(runtimeRoot))
    throw new Error("An absolute runtime credential directory is required.");
  const directory = await readAgentConfig(directoryFile),
    names = Object.keys(directory.agents).sort();
  if (names.length < 2) throw new Error("Register at least two agents.");
  for (const value of Object.values(directory.agents)) {
    if (
      value.bearerTokenFile ||
      value.bearerTokenEnv ||
      value.incomingBearerTokenFile
    )
      throw new Error(
        "The registration directory must contain endpoints only.",
      );
  }
  const requested = resolve(outputRoot),
    parent = await realpath(dirname(requested)),
    output = join(parent, basename(requested));
  for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
    try {
      await stat(join(ancestor, ".git"));
      throw new Error("Credentials must stay outside Git checkouts.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(ancestor) === ancestor) break;
  }
  await privateDirectory(output);
  for (const name of names) await privateDirectory(join(output, name));
  for (const from of names)
    for (const to of names) {
      if (from === to) continue;
      const outgoing = join(output, from, `${to}.outgoing.token`),
        incoming = join(output, to, `${from}.incoming.token`);
      const left = await existingToken(outgoing),
        right = await existingToken(incoming);
      if (left && right && left !== right)
        throw new Error(
          "Retained pair credentials conflict; inspect without printing values.",
        );
      const token = left ?? right ?? randomBytes(32).toString("hex");
      if (!left) {
        const handle = await open(outgoing, "wx", 0o600);
        try {
          await handle.writeFile(token + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      if (!right) {
        const handle = await open(incoming, "wx", 0o600);
        try {
          await handle.writeFile(token + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
  for (const from of names) {
    const agents = {};
    for (const to of names) {
      agents[to] = {
        ...directory.agents[to],
        ...(from === to
          ? {}
          : {
              bearerTokenFile: join(runtimeRoot, `${to}.outgoing.token`),
              incomingBearerTokenFile: join(
                runtimeRoot,
                `${to}.incoming.token`,
              ),
            }),
      };
    }
    await saveConfig(join(output, from, "agents.json"), { agents });
  }
  return {
    agents: names,
    directedPairs: names.length * (names.length - 1),
    credentialsPrinted: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help")
    console.log(
      "Usage: node examples/mesh/provision.mjs DIRECTORY_JSON PRIVATE_OUTPUT_ROOT ABSOLUTE_RUNTIME_DIRECTORY",
    );
  else if (args.length !== 3) {
    console.error(
      "Expected a registered endpoint directory, private output root and absolute runtime directory.",
    );
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await provisionPeers(...args)));
    } catch {
      console.error(
        "Peer provisioning failed. Inspect retained files before retrying; no credential value was printed or existing key overwritten.",
      );
      process.exitCode = 1;
    }
  }
}
