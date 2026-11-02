/**
 * Test helpers: programs planted where git or the Daemon must never start them. Each one
 * records its arguments in `<its own path>.ran` and fails, so a test sees whether it ran.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const RECORDER_SOURCE = `import { appendFileSync } from "node:fs";
appendFileSync(process.execPath + ".ran", process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`;

let compiled: string | undefined;

/** A real Windows executable that records and fails, compiled once per test process. */
const windowsRecorder = () => {
  if (compiled !== undefined) return compiled;

  const dir = newTempDir("polaris-recorder-");
  // The compiled program is a whole Bun runtime: never leave it behind.
  process.on("exit", () => removeTempDir(dir));
  const source = join(dir, "recorder.ts");
  const out = join(dir, "recorder.exe");
  writeFileSync(source, RECORDER_SOURCE);

  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", out], {
    stdout: "ignore",
    stderr: "pipe",
  });

  if (built.exitCode !== 0)
    throw new Error(`could not compile the recorder: ${built.stderr.toString()}`);
  compiled = out;

  return out;
};

/**
 * Plants `name` in `dir`: an executable for `.exe`/`.com`, a batch file for `.bat`/`.cmd`,
 * else a shell script. Returns its path.
 */
export const plant = (dir: string, name: string): string => {
  const path = join(dir, name);
  mkdirSync(dir, { recursive: true });

  if (/\.(exe|com)$/i.test(name)) copyFileSync(windowsRecorder(), path);
  else if (/\.(bat|cmd)$/i.test(name))
    writeFileSync(path, '@echo %* >> "%~f0.ran"\r\n@exit /b 1\r\n');
  else {
    writeFileSync(path, '#!/bin/sh\necho "$@" >> "$0.ran"\ncat >/dev/null\nexit 1\n');
    chmodSync(path, 0o755);
  }

  return path;
};

/** The names a bare `program` may be found by: Windows' extensions there, the name itself here. */
export const plantedNames = (program: string): ReadonlyArray<string> =>
  process.platform === "win32"
    ? [`${program}.exe`, `${program}.com`, `${program}.bat`, `${program}.cmd`, program]
    : [program];

/** Plants every name a bare `program` may be found by in `dir`; returns their paths. */
export const plantAll = (dir: string, program: string): ReadonlyArray<string> =>
  plantedNames(program).map((name) => plant(dir, name));

/** The Host's own `program` in `dir` (put it on PATH): prints `text` and succeeds. Its path. */
export const hostProgram = (dir: string, program: string, text: string): string => {
  mkdirSync(dir, { recursive: true });

  if (process.platform === "win32") {
    const path = join(dir, `${program}.cmd`);
    writeFileSync(path, `@echo ${text}\r\n`);

    return path;
  }

  const path = join(dir, program);
  writeFileSync(path, `#!/bin/sh\necho ${text}\n`);
  chmodSync(path, 0o755);

  return path;
};

/** Planted programs that ran: each one's path, and what it recorded. */
export const ranOf = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.flatMap((path) => {
    const ran = recorded(path);

    return ran === null ? [] : [`${path}: ${ran}`];
  });

/** What a planted program recorded, or null when it never ran. */
export const recorded = (path: string): string | null =>
  existsSync(`${path}.ran`) ? readFileSync(`${path}.ran`, "utf8") : null;
