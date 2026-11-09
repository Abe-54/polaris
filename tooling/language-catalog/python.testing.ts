import { spawnSync } from "node:child_process";

/** The catalog scripts use `hashlib.file_digest`, new in Python 3.11. */
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

/** The first Python 3.11+ found: `POLARIS_PYTHON`, then `python3`, then `python3.15`…`python3.11`. */
export const python = CANDIDATES.find(
  (command): command is string => command !== undefined && command !== "" && supported(command)
);

/** The message a test reports when no supported Python is on this Host. */
export const missingPython = (script: string): string =>
  `${script} needs Python 3.11 or newer; found none (tried POLARIS_PYTHON, then python3, python3.15…python3.11 on PATH)`;

/** CI must run Python tests, so there a missing Python fails rather than skips. */
export const skipPython = python === undefined && !process.env.CI;
