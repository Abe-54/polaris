import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { missingPython, python, skipPython } from "./python.testing";

const MISSING = missingPython("fixture_test.py");

if (skipPython) console.warn(`skip: ${MISSING}`);

test.skipIf(skipPython)(
  "fixture poison, canonical temporary paths and bounded descendant cleanup",
  () => {
    if (python === undefined) throw new Error(MISSING);
    execFileSync(python, [join(import.meta.dir, "fixture_test.py")], { timeout: 20000 });
  },
  25000
);
