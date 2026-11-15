import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";

interface Workflow {
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string[];
      steps?: { uses?: string; run?: string; with?: Record<string, unknown> }[];
    }
  >;
}
interface PackageManifest {
  packageManager: string;
  trustedDependencies: string[];
}
const directory = new URL("../.github/workflows/", import.meta.url);

for (const file of readdirSync(directory).filter((file) =>
  file.endsWith(".yaml"),
)) {
  test(`${file} pins third-party actions and keeps checkout credentials out of the workspace`, () => {
    const workflow = parse(
      readFileSync(new URL(file, directory), "utf8"),
    ) as Workflow;
    assert.equal(workflow.permissions.contents, "read");
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./")) {
          assert.match(step.uses, /@[0-9a-f]{40}$/);
        }
        if (step.uses?.startsWith("actions/checkout@")) {
          assert.equal(step.with?.["persist-credentials"], false);
        }
      }
    }
  });
}

test("the required check includes every CI job and never hides failed prerequisites", () => {
  const ci = parse(
    readFileSync(new URL("ci.yaml", directory), "utf8"),
  ) as Workflow;
  const required = ci.jobs.required;
  assert(required);
  assert.deepEqual(
    [...(required.needs ?? [])].sort(),
    Object.keys(ci.jobs)
      .filter((name) => name !== "required")
      .sort(),
  );
  assert.equal(required.if, "always()");
  const gate = required.steps?.map((step) => step.run ?? "").join("\n");
  assert(gate?.includes('result !== "success"'));
  assert(gate?.includes('optional && result === "skipped"'));
});

test("the development toolchain is Bun but runtime sources do not import Bun APIs", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;
  assert.match(manifest.packageManager, /^bun@\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.trustedDependencies, []);
  for (const file of readdirSync(new URL("../src/", import.meta.url)).filter(
    (file) => file.endsWith(".ts"),
  )) {
    const source = readFileSync(
      new URL(`../src/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:from\s*|import\s*\()\s*["']bun(?::[^"']*)?["']/,
    );
    assert.doesNotMatch(source, /\bBun\./);
  }
});
