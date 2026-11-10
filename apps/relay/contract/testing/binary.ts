/**
 * The relay's release binary, for every suite that starts a relay. cargo builds it on first
 * use, which takes no time when it is fresh; `POLARIS_RELAY_BIN` names one built elsewhere.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const workspace = join(import.meta.dir, "../..");

const NAME = process.platform === "win32" ? "polaris-relay.exe" : "polaris-relay";

const SNAPSHOT_ATTEMPTS = 200;

/**
 * A copy of `built` that stays put. cargo replaces its output on every build, a fresh one
 * included, so under parallel test processes the file is missing for a moment at a time.
 */
const snapshot = (built: string, directory: string): string => {
  mkdirSync(directory, { recursive: true });

  for (let attempt = 1; ; attempt++) {
    try {
      const { mtimeMs, size } = statSync(built);
      const copy = join(directory, `${Math.trunc(mtimeMs)}-${size}-${NAME}`);

      if (!existsSync(copy)) {
        const partial = `${copy}.${process.pid}`;

        copyFileSync(built, partial);
        renameSync(partial, copy);
      }

      return copy;
    } catch (error) {
      if (attempt === SNAPSHOT_ATTEMPTS) throw error;
      Bun.sleepSync(5);
    }
  }
};

const build = (): string => {
  const given = process.env.POLARIS_RELAY_BIN ?? "";

  if (given !== "") return given;

  const cargo = Bun.which("cargo");

  if (cargo === null)
    throw new Error("the relay is built with cargo, which is not on PATH (see CONTRIBUTING.md)");

  const built = Bun.spawnSync([cargo, "build", "--release", "--locked", "-p", "polaris-relay"], {
    cwd: workspace,
    stdout: "ignore",
    stderr: "pipe",
  });

  if (built.exitCode !== 0)
    throw new Error(`cargo could not build the relay (apps/relay):\n${built.stderr.toString()}`);
  const target = process.env.CARGO_TARGET_DIR ?? join(workspace, "target");

  return snapshot(join(target, "release", NAME), join(target, "contract"));
};

let binary: string | null = null;

/** The path of the relay binary, built once per process. Call it outside a test's timeout. */
export const relayBinary = (): string => (binary ??= build());
