import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runGitCliff } from "git-cliff";

const config = JSON.parse(
  readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8"),
);
const analyzerName: string = "@semantic-release/commit-analyzer";
const { analyzeCommits } = await import(analyzerName);

for (const [message, release] of [
  ["feat: observe a new lifecycle event", "minor"],
  ["fix: include the telemetry runtime", "patch"],
  ["fix(deps): update the telemetry exporter", "patch"],
  ["perf: reduce allocation overhead", "patch"],
  ["revert: restore the previous exporter", "patch"],
  ["docs(readme): explain collector configuration", "patch"],
  ["feat!: require a newer Pi SDK", "minor"],
  [
    "chore: update the toolchain\n\nBREAKING CHANGE: requires a newer Node.js",
    "minor",
  ],
  ["chore(deps): update TypeScript", null],
  ["ci: update runners", null],
  ["docs: update the maintainer guide", null],
] as const) {
  test(`release rules: ${message.split("\n")[0]}`, async () => {
    const result = await analyzeCommits(config.plugins[0][1], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      commits: [{ hash: "fixture", message }],
      logger: { log() {} },
    });
    assert.equal(result, release);
  });
}

test("git-cliff generates Pi-readable notes with breaking changes and absolute PR links", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-a2a-release-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const commit = (message: string) =>
    git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      message,
      "-m",
      "Signed-off-by: leocavalcante <git@leocavalcante.dev>",
    );
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Fixture maintainer");
    git("config", "user.email", "fixture@example.invalid");
    commit("feat: initial fixture");
    git("tag", "v0.1.2");
    commit("fix: ship the telemetry runtime (#42)");
    commit("chore!: require a newer Pi SDK");
    commit("ci: update runners");
    const args = [
      "--config",
      fileURLToPath(new URL("../cliff.toml", import.meta.url)),
      "--tag",
      "v0.2.0",
    ];
    const notes = await runGitCliff(
      [...args, "--unreleased", "--strip", "all"],
      {
        cwd: directory,
        stdio: "pipe",
      },
    );
    assert(typeof notes.stdout === "string");
    assert.match(notes.stdout, /^## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}/);
    assert.match(notes.stdout, /Breaking changes/);
    assert.match(notes.stdout, /\*\*Breaking:\*\* Require a newer Pi SDK/);
    assert.match(
      notes.stdout,
      /https:\/\/github\.com\/leocavalcante\/pi-a2a\/pull\/42/,
    );
    assert.doesNotMatch(notes.stdout, /Update runners|Initial fixture/);
    const history = await runGitCliff(args, { cwd: directory, stdio: "pipe" });
    assert(typeof history.stdout === "string");
    assert.match(history.stdout, /^# Changelog/);
    assert.match(history.stdout, /## \[0\.1\.2\]/);
    assert.equal(
      git("tag", "--list", "v0.2.0").trim(),
      "",
      "Changelog generation must not create tags",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
