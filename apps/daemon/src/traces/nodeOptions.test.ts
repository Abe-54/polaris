import { expect, test } from "bun:test";
import { appendNodeImport } from "./nodeOptions.ts";

test("Node preload composition preserves existing options and quotes a path with spaces", () => {
  expect(
    appendNodeImport("--max-old-space-size=256 --import existing.mjs", "/tmp/a b/register.mjs")
  ).toBe('--max-old-space-size=256 --import existing.mjs --import "/tmp/a b/register.mjs"');
});
