import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { missingPython, python, skipPython } from "./python.testing";

const MISSING = missingPython("bounded_build_test.py");

if (skipPython) console.warn(`skip: ${MISSING}`);

test.skipIf(skipPython)(
  "synthetic source-build deadline, disk, archive and compiler-drift guards",
  () => {
    if (python === undefined) throw new Error(MISSING);
    execFileSync(python, [join(import.meta.dir, "bounded_build_test.py")], {
      timeout: 20000,
      stdio: "pipe",
    });
  },
  25000
);
