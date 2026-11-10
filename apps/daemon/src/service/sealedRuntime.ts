/**
 * Seals the Bun runtime inside a compiled darwin Daemon (ENG-875, ADR 0105). Bun reads a few
 * environment variables before the Daemon's code runs and they make the signed binary run
 * anybody's JavaScript. Bun has no switch for them, so the build renames them inside the
 * binary to `DYLD_` names: Bun no longer reads the old names, and dyld removes every `DYLD_`
 * variable from a hardened-runtime process before `main`. Used by `scripts/build-daemon.ts`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The variables' names and how often each stands in Bun 1.4.4's darwin-arm64 runtime.
 * `BUN_INSPECT` also counts `BUN_INSPECT_CONNECT_TO`, `_PRELOAD` and `_NOTIFY`.
 */
export const SEALED_VARIABLES: ReadonlyArray<{ readonly name: string; readonly count: number }> = [
  { name: "BUN_BE_BUN", count: 1 },
  { name: "BUN_OPTIONS", count: 2 },
  { name: "BUN_INSPECT", count: 11 },
];

const PREFIX = "DYLD_";

/** The name a sealed runtime reads instead: same length, so nothing in the binary moves. */
export const sealedName = (name: string) => `${PREFIX}${name.slice(PREFIX.length)}`;

const MACH_O_64 = 0xfe_ed_fa_cf;

const LC_SEGMENT_64 = 0x19;

/** Where the embedded program (`__BUN`) is in a compiled Mach-O: its text is left alone. */
const embeddedProgram = (bytes: Buffer) => {
  if (bytes.readUInt32LE(0) !== MACH_O_64) throw new Error("not a 64-bit Mach-O executable");
  const commands = bytes.readUInt32LE(16);
  let at = 32;

  for (let index = 0; index < commands; index++) {
    const name = bytes.toString("latin1", at + 8, at + 24).replace(/\0+$/, "");

    if (bytes.readUInt32LE(at) === LC_SEGMENT_64 && name === "__BUN") {
      const start = Number(bytes.readBigUInt64LE(at + 40));

      return { start, end: start + Number(bytes.readBigUInt64LE(at + 48)) };
    }

    at += bytes.readUInt32LE(at + 4);
  }

  throw new Error("no __BUN segment: not a compiled Bun executable");
};

/** Renames `name` everywhere in the runtime, and says how often. */
const rename = (bytes: Buffer, name: string, program: ReturnType<typeof embeddedProgram>) => {
  let count = 0;
  let at = bytes.indexOf(name);

  while (at !== -1) {
    if (at >= program.end || at + name.length <= program.start) {
      bytes.write(PREFIX, at, "latin1");
      count++;
    }

    at = bytes.indexOf(name, at + name.length);
  }

  return count;
};

/**
 * Seals the compiled darwin executable at `path` in place; its signature must be made after.
 * Throws, writing nothing, when a name is not there as often as expected: a Bun upgrade
 * changed the runtime and the routes must be read again (ADR 0105).
 */
export const sealRuntime = (path: string): void => {
  const bytes = readFileSync(path);
  const program = embeddedProgram(bytes);

  for (const { name, count } of SEALED_VARIABLES) {
    const found = rename(bytes, name, program);

    if (found !== count) {
      throw new Error(
        `${path}: ${name} stands ${found} times in the Bun runtime, expected ${count}; see docs/adr/0105`
      );
    }
  }

  writeFileSync(path, bytes);
};

type Route = {
  readonly name: string;
  readonly env: (script: string) => Record<string, string>;
  /** Arguments instead of the ordinary command's. */
  readonly args?: (script: string) => ReadonlyArray<string>;
};

const options = (flag: string): Route => ({
  name: `BUN_OPTIONS ${flag}`,
  env: (script) => ({ BUN_OPTIONS: `${flag} ${script}` }),
});

/** Each way the runtime's environment makes a compiled executable run foreign JavaScript. */
const ROUTES: ReadonlyArray<Route> = [
  { name: "BUN_BE_BUN", env: () => ({ BUN_BE_BUN: "1" }), args: (script) => [script] },
  options("--preload"),
  options("--require"),
  options("--import"),
  // An unsealed runtime waits for a debugger, which evaluates what it is sent.
  { name: "BUN_INSPECT", env: () => ({ BUN_INSPECT: "ws://127.0.0.1:0/polaris?wait=1" }) },
];

const sealedEnv = (env: Record<string, string>) =>
  Object.fromEntries(Object.entries(env).map(([name, value]) => [sealedName(name), value]));

export type OpenRoutesOptions = {
  /** A command of the executable that ends by itself, e.g. `["version"]`. */
  readonly command: ReadonlyArray<string>;
  /** `sealed` sets the renamed variables: what an attacker who read this file would try. */
  readonly names: "bun" | "sealed";
  /** How long a run may take before it counts as waiting for a debugger. */
  readonly timeoutMs?: number;
};

/**
 * Runs `binary` once per route with a script that leaves a marker, and names the routes
 * that ran it (or left the executable waiting for a debugger). Empty for a sealed runtime.
 */
export const openRoutes = async (
  binary: string,
  { command, names, timeoutMs = 20_000 }: OpenRoutesOptions
): Promise<ReadonlyArray<string>> => {
  const dir = mkdtempSync(join(tmpdir(), "polaris-seal-"));
  const marker = join(dir, "ran");
  const script = join(dir, "script.js");
  const open: string[] = [];

  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`);

  try {
    for (const route of ROUTES) {
      const env = route.env(script);

      const proc = Bun.spawn([binary, ...(route.args?.(script) ?? command)], {
        env: { HOME: dir, POLARIS_HOME: dir, ...(names === "sealed" ? sealedEnv(env) : env) },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });

      let waited = false;

      const timer = setTimeout(() => {
        waited = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      await proc.exited;
      clearTimeout(timer);

      if (waited || existsSync(marker)) open.push(route.name);
      rmSync(marker, { force: true });
    }

    return open;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
