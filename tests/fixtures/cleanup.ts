import type { TestContext } from "node:test";

/**
 * Collects cleanups and runs them in reverse order after the test, like `defer`.
 *
 * node:test runs `t.after` hooks in registration order, so a temporary directory
 * registered first would be removed before the stores inside it close. Windows
 * refuses to delete an open SQLite database, so close everything first.
 */
export function deferred(t: TestContext): (step: () => unknown) => void {
  const steps: (() => unknown)[] = [];
  t.after(async () => {
    let failure: unknown;
    for (const step of steps.reverse()) {
      try {
        await step();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure instanceof Error) throw failure;
    if (failure !== undefined)
      throw new Error("Cleanup rejected with a non-Error value.");
  });
  return (step) => {
    steps.push(step);
  };
}
