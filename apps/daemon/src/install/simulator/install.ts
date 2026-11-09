/**
 * Installs the pinned Simulator tools into `<root>/<version>/` with the Daemon's own Bun:
 * `bun install --frozen-lockfile` checks every tarball against the lockfile's sha512, runs no
 * lifecycle scripts, and the result is renamed into place only once both entry scripts exist.
 */
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { childEnv } from "../../service/childEnv.ts";
import {
  SIMULATOR_TOOLS_ENTRIES,
  SIMULATOR_TOOLS_LOCKFILE,
  SIMULATOR_TOOLS_MANIFEST,
  SIMULATOR_TOOLS_VERSION,
} from "./pin.ts";

/** Runs a script as Bun: the compiled `polaris` is Bun with `BUN_BE_BUN=1`, and `bun` from source. */
export const bunRuntime = () => ({ argv: [process.execPath], env: { BUN_BE_BUN: "1" } });

export interface SimulatorToolsOptions {
  /** Holds one directory per installed version. */
  readonly root: string;
  readonly version?: string;
  readonly manifest?: object;
  readonly lockfile?: string;
  readonly entries?: { readonly hub: string; readonly agentDevice: string };
  /** Added to the install's environment; tests point `BUN_CONFIG_REGISTRY` at a fake registry. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface InstalledSimulatorTools {
  readonly dir: string;
  /** expo-device-hub's CLI script. */
  readonly hub: string;
  /** agent-device's CLI script. */
  readonly agentDevice: string;
}

/** Written last, inside the staging directory, so a directory without it is never used. */
const MARKER = ".polaris-installed";

const pinnedOf = (options: SimulatorToolsOptions) => {
  const version = options.version ?? SIMULATOR_TOOLS_VERSION;
  const entries = options.entries ?? SIMULATOR_TOOLS_ENTRIES;
  const dir = join(options.root, version);

  return {
    version,
    dir,
    entries,
    installed: {
      dir,
      hub: join(dir, entries.hub),
      agentDevice: join(dir, entries.agentDevice),
    } satisfies InstalledSimulatorTools,
  };
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  );

/** The pinned tools if they are in place: one `stat` of the marker. */
export const installedOnDisk = async (
  options: SimulatorToolsOptions
): Promise<InstalledSimulatorTools | null> => {
  const { dir, installed } = pinnedOf(options);

  return (await exists(join(dir, MARKER))) ? installed : null;
};

/** bun's own `error:` lines: they name the package and the check, not the Host's paths. */
const errorLines = (stderr: string) =>
  stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("error:"))
    .join("; ");

const bunInstall = async (cwd: string, options: SimulatorToolsOptions) => {
  const runtime = bunRuntime();

  const spawnOptions: Bun.SpawnOptions.SpawnOptions<"ignore", "ignore", "pipe"> = {
    env: {
      ...childEnv(),
      ...runtime.env,
      BUN_INSTALL_CACHE_DIR: join(cwd, ".cache"),
      ...options.env,
    },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  };

  if (options.signal !== undefined) spawnOptions.signal = options.signal;

  // bunRuntime's program: the Daemon's own binary, run as Bun.
  const proc = Bun.spawn(
    [
      process.execPath,
      `--cwd=${cwd}`,
      "install",
      "--frozen-lockfile",
      "--production",
      "--ignore-scripts",
      "--linker=hoisted",
      "--no-progress",
      "--no-summary",
    ],
    spawnOptions
  );

  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

  if (code !== 0)
    throw new Error(`bun install failed (exit ${code}): ${errorLines(stderr) || "no error line"}`);
};

export const installSimulatorTools = async (
  options: SimulatorToolsOptions
): Promise<InstalledSimulatorTools> => {
  const { version, dir, entries, installed } = pinnedOf(options);
  const staging = `${dir}.part`;

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify(options.manifest ?? SIMULATOR_TOOLS_MANIFEST)
  );
  await writeFile(join(staging, "bun.lock"), options.lockfile ?? SIMULATOR_TOOLS_LOCKFILE);
  await bunInstall(staging, options);
  await rm(join(staging, ".cache"), { recursive: true, force: true });

  for (const entry of [entries.hub, entries.agentDevice])
    if (!(await exists(join(staging, entry)))) throw new Error(`the install has no ${entry}`);

  await writeFile(join(staging, MARKER), version);
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  await pruneOlder(options.root, version);

  return installed;
};

/** A running hub keeps its old files open on Unix; the Simulator is never on Windows. */
const pruneOlder = async (root: string, keep: string) => {
  const entries = await readdir(root);

  await Promise.all(
    entries
      .filter((name) => name !== keep)
      .map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {}))
  );
};
