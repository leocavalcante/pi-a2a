// Shared by every Pi extension: keep this file identical in each repository.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const readme = read("../README.md");
const manifest = JSON.parse(read("../package.json")) as {
  name: string;
  description: string;
};
const name = manifest.name.replace(/^@leocavalcante\//, "");

test("the README opens with the extension name and its npm description", () => {
  const [title, blank, description] = readme.split("\n");
  assert.equal(title, `# ${name}`);
  assert.equal(blank, "");
  assert.equal(description, manifest.description);
});

test("the README links every Pi extension with the shared section from the standard", () => {
  const standard = read("../docs/pi-extension-standard.md");
  // The section sits in a fenced markdown block; Prettier may normalize the fence length.
  const shared =
    /### A\.12 More Pi extensions\n[\s\S]*?(`{3,})markdown\n([\s\S]*?)\n\1\n/.exec(
      standard,
    )?.[2];
  assert.ok(shared, "The standard defines the shared section in A.12.");
  assert.ok(
    readme.includes(`\n${shared}\n`),
    'Copy "More Pi extensions" from the standard (A.12) verbatim.',
  );
  const row = shared
    .split("\n")
    .find((line) => line.startsWith(`| [${name}](`));
  assert.ok(row, `Add ${name} to the table in A.12.`);
  assert.ok(
    row.includes(`| ${manifest.description} `),
    `The ${name} row repeats the package.json description.`,
  );
});
