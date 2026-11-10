import { expect, test } from "bun:test";
import { negotiate } from "./capabilities.ts";

const declares = (capabilities: Record<string, boolean | { workDoneProgress: boolean }>) =>
  negotiate({ capabilities: { definitionProvider: true, ...capabilities } }).methods.includes(
    "textDocument/declaration"
  );

test("a server's declarationProvider makes textDocument/declaration a method the Daemon forwards", () => {
  expect([
    declares({ declarationProvider: true }),
    declares({ declarationProvider: { workDoneProgress: false } }),
    declares({ declarationProvider: false }),
    declares({}),
  ]).toEqual([true, true, false, false]);
});
