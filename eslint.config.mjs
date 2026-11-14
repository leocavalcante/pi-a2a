// @ts-check
// Shared by every Pi extension: keep this file identical in each repository.
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// Tests inspect dynamically shaped JSON, protocol, and subprocess payloads;
// keep these relaxations test-only.
const testPayloadRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules)
    .filter(
      (name) =>
        name.startsWith("no-unsafe-") ||
        name === "no-explicit-any" ||
        name === "no-non-null-assertion",
    )
    .map((name) => [`@typescript-eslint/${name}`, "off"]),
);

export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Node's test runner owns and reports the promises its declarations return.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            {
              from: "package",
              name: ["test", "it", "describe", "suite"],
              package: "node:test",
            },
          ],
        },
      ],
    },
  },
  {
    // Runtime code. A root index.ts, where a repository keeps one, re-exports src/.
    files: ["index.ts", "src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bun", "bun:*"],
              message:
                "Pi runs extensions on Node.js. Use node:* APIs in runtime code.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      ...testPayloadRules,
      // Async test doubles keep Promise-shaped contracts.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // JavaScript subprocess fixtures use no-op callbacks, empty cleanup catches,
    // computed environment keys, and constant worker loops.
    files: ["tests/**/*.{js,mjs,cjs}"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "no-constant-condition": "off",
      "no-empty": "off",
    },
  },
  prettier,
);
