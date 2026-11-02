import { test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

/** The scripts under test use `hashlib.file_digest`, new in Python 3.11. */
const CANDIDATES = [
  process.env.POLARIS_PYTHON,
  "python3",
  "python3.15",
  "python3.14",
  "python3.13",
  "python3.12",
  "python3.11",
];

const supported = (command: string): boolean =>
  spawnSync(command, ["-c", "import sys; sys.exit(sys.version_info < (3, 11))"], { timeout: 5000 })
    .status === 0;

const python = CANDIDATES.find(
  (command): command is string => command !== undefined && command !== "" && supported(command)
);

const MISSING =
  "bounded_build_test.py needs Python 3.11 or newer; found none (tried POLARIS_PYTHON, then python3, python3.15…python3.11 on PATH)";

// CI must run it, so there a missing Python fails rather than skips.
const skip = python === undefined && !process.env.CI;

if (skip) console.warn(`skip: ${MISSING}`);

test.skipIf(skip)(
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
