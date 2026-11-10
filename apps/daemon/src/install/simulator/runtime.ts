/**
 * The Bun that runs the Simulator's tools. A Daemon from source or an unsealed build is Bun
 * itself (`BUN_BE_BUN=1`); a sealed release Daemon refuses to be (ADR 0108), so it installs
 * Oven's pinned Bun into `<root>/<version>/`: downloaded, hash-checked, then renamed into place.
 */
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { executableOf } from "../../platform/executable.ts";
import {
  downloadFile,
  type Fetcher,
  partPath,
  sha256Of,
} from "../../prediction/managed/download.ts";
import { childEnv } from "../../service/childEnv.ts";
import { BUN_RUNTIME_BUILDS, BUN_RUNTIME_VERSION, type PinnedBunRuntime } from "./runtimePin.ts";

/** How to run a script as Bun: the program, by its absolute path, and what its environment adds. */
export interface BunRuntime {
  readonly program: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The Daemon's own executable as Bun: `bun` from source, a compiled `polaris` by `BUN_BE_BUN=1`. */
export const ownBun = (executable: string = process.execPath): BunRuntime => ({
  program: executable,
  env: { BUN_BE_BUN: "1" },
});

const PROBE_TIMEOUT_MS = 20_000;

/** Whether `executable` answers as Bun when asked to be: a sealed Daemon prints its usage instead. */
export const runsAsBun = async (executable: string = process.execPath): Promise<boolean> => {
  const runtime = ownBun(executable);

  const proc = Bun.spawn([executableOf(runtime.program), "--version"], {
    env: childEnv({ ...process.env, ...runtime.env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: PROBE_TIMEOUT_MS,
  });

  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return code === 0 && stdout.trim().startsWith(Bun.version);
};

export interface BunRuntimeOptions {
  /** Holds one directory per installed version. */
  readonly root: string;
  /** `runtimePlatform()`: `<os>-<arch>`. */
  readonly platform: string;
  /** The Daemon's executable; tests pass a built one. */
  readonly executable?: string;
  readonly version?: string;
  readonly builds?: Readonly<Record<string, PinnedBunRuntime>>;
  readonly fetch?: Fetcher;
  /** Unpacks the release's `.zip` into a folder; macOS's `tar` reads zips. */
  readonly extract?: (archive: string, dir: string) => Promise<void>;
}

/** Where the Simulator's installer gets its Bun: what is in place now, and how to get it. */
export interface BunRuntimeSource {
  readonly onDisk: () => Promise<BunRuntime | null>;
  readonly install: (signal?: AbortSignal) => Promise<BunRuntime>;
}

/** The Daemon is sealed and no Bun is pinned for its platform. */
export class NoBunRuntime extends Error {}

const pinnedFor = (options: BunRuntimeOptions) => {
  const version = options.version ?? BUN_RUNTIME_VERSION;
  const builds: Readonly<Record<string, PinnedBunRuntime>> = options.builds ?? BUN_RUNTIME_BUILDS;
  const build = Object.hasOwn(builds, options.platform) ? builds[options.platform] : undefined;

  if (build === undefined)
    throw new NoBunRuntime(`no Bun ${version} to run the Simulator's tools on ${options.platform}`);
  const dir = join(options.root, version);

  return { version, build, dir, binary: join(dir, build.binary.path) };
};

const sizeOf = (path: string) =>
  stat(path).then(
    (info) => (info.isFile() ? info.size : null),
    () => null
  );

const extractZip = async (archive: string, dir: string): Promise<void> => {
  const child = Bun.spawn([executableOf("tar"), "-xf", archive, "-C", dir], {
    env: childEnv(process.env),
    stderr: "pipe",
    stdout: "ignore",
  });

  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);

  if (code !== 0) throw new Error(stderr.trim() || `tar exited with ${code}`);
};

/** A run in flight may still hold an older Bun open: Unix keeps the file until it ends. */
const pruneOlder = async (root: string, keep: string) => {
  const entries = await readdir(root);

  await Promise.all(
    entries
      .filter((name) => name !== keep)
      .map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {}))
  );
};

const plain = (binary: string): BunRuntime => ({ program: binary, env: {} });

/**
 * Installs the pinned Bun. The archive is checked against its hash as it lands, and the `bun`
 * inside against its own before it is made executable; only then is its folder renamed in.
 */
const installPinned = async (options: BunRuntimeOptions, signal: AbortSignal) => {
  const { version, build, dir, binary } = pinnedFor(options);

  if ((await sizeOf(binary)) === build.binary.sizeBytes) return plain(binary);

  // A `.part` here survives a failed attempt, so the next one resumes it.
  const download = join(options.root, `${version}.download`);
  const staging = join(options.root, `${version}.staging`);

  try {
    await downloadFile({
      file: build.archive,
      dir: download,
      fetch: options.fetch ?? fetch,
      signal,
      onProgress: () => {},
    });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await (options.extract ?? extractZip)(join(download, build.archive.name), staging);
    const unpacked = join(staging, build.binary.path);

    if (
      (await sizeOf(unpacked)) !== build.binary.sizeBytes ||
      (await sha256Of(unpacked, signal)) !== build.binary.sha256
    )
      throw new Error(`Bun ${version}'s archive has no bun of its pinned size and hash`);
    await chmod(unpacked, 0o755);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } catch (cause) {
    await rm(staging, { recursive: true, force: true });

    // Only a download cut short is worth keeping; a refused one leaves nothing.
    if ((await sizeOf(partPath(download, build.archive))) === null)
      await rm(download, { recursive: true, force: true });

    throw cause;
  }

  await rm(download, { recursive: true, force: true });
  await pruneOlder(options.root, version);

  return plain(binary);
};

/** The Daemon's own Bun where it still is one, else the pinned Bun under `options.root`. */
export const bunRuntimeSource = (options: BunRuntimeOptions): BunRuntimeSource => {
  let own: Promise<boolean> | null = null;

  const isOwn = () => (own ??= runsAsBun(options.executable));

  return {
    onDisk: async () => {
      if (await isOwn()) return ownBun(options.executable);
      const { build, binary } = pinnedFor(options);

      return (await sizeOf(binary)) === build.binary.sizeBytes ? plain(binary) : null;
    },
    install: async (signal = new AbortController().signal) =>
      (await isOwn()) ? ownBun(options.executable) : installPinned(options, signal),
  };
};

/** Every caller of the Daemon's own Bun: tests, and an installer given no other source. */
export const ownBunSource: BunRuntimeSource = {
  onDisk: async () => ownBun(),
  install: async () => ownBun(),
};
