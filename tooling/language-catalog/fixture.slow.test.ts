import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

test("fixture poison, canonical temporary paths and bounded descendant cleanup", () => {
  execFileSync("python3", [join(import.meta.dir, "fixture_test.py")], { timeout: 20000 });
}, 25000);
