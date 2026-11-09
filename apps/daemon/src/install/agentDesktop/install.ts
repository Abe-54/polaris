/**
 * Installs the pinned agent-desktop into `<root>/<version>/`: the archive is downloaded and
 * checked like every pinned file, unpacked beside it, and the whole folder renamed into place.
 */
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { downloadFile, type Fetcher } from "../../prediction/managed/download.ts";
import { extractBuild } from "../../prediction/managed/process.ts";
import { AGENT_DESKTOP_BUILDS, AGENT_DESKTOP_VERSION, type PinnedBuild } from "./pin.ts";

export interface InstallOptions {
  /** Holds one directory per installed version. */
  readonly root: string;
  /** `runtimePlatform()`: `<os>-<arch>`, plus `-musl` on a musl Linux. */
  readonly platform: string;
  readonly version?: string;
  readonly builds?: Readonly<Record<string, PinnedBuild>>;
  readonly fetch?: Fetcher;
  /** Unpacks a `.tar.gz` into a folder; the Daemon runs the Host's `tar`. */
  readonly extract?: (archive: string, dir: string) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface InstalledAgentDesktop {
  readonly binary: string;
}

/** The platform has no agent-desktop build, or none was pinned. */
export class NoAgentDesktopBuild extends Error {}

const pinnedFor = (options: InstallOptions) => {
  const version = options.version ?? AGENT_DESKTOP_VERSION;
  const builds: Readonly<Record<string, PinnedBuild>> = options.builds ?? AGENT_DESKTOP_BUILDS;
  const build = Object.hasOwn(builds, options.platform) ? builds[options.platform] : undefined;

  if (build === undefined)
    throw new NoAgentDesktopBuild(`no agent-desktop build for ${options.platform}`);

  return { version, build, dir: join(options.root, version) };
};

/** A file of exactly the pinned size, or null. */
const pinnedSize = async (path: string, sizeBytes: number) => {
  const info = await stat(path).catch(() => null);

  return info?.isFile() === true && info.size === sizeBytes;
};

/**
 * The pinned binary if it is already in place, by size alone: the version folder appears only
 * by a rename after the archive's hash matched, so this costs one `stat`.
 */
export const installedOnDisk = async (
  options: InstallOptions
): Promise<InstalledAgentDesktop | null> => {
  const { build, dir } = pinnedFor(options);
  const binary = join(dir, build.binary.name);

  return (await pinnedSize(binary, build.binary.sizeBytes)) ? { binary } : null;
};

export const installAgentDesktop = async (
  options: InstallOptions
): Promise<InstalledAgentDesktop> => {
  const { version, build, dir } = pinnedFor(options);
  const binary = join(dir, build.binary.name);

  if (await pinnedSize(binary, build.binary.sizeBytes)) return { binary };

  // A `.part` here survives a failed attempt, so the next one resumes it.
  const download = join(options.root, `${version}.download`);
  const staging = join(options.root, `${version}.staging`);
  await downloadFile({
    file: build.archive,
    dir: download,
    fetch: options.fetch ?? fetch,
    signal: options.signal ?? new AbortController().signal,
    onProgress: () => {},
  });

  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await (options.extract ?? extractBuild)(join(download, build.archive.name), staging);
  const unpacked = join(staging, build.binary.name);

  if (!(await pinnedSize(unpacked, build.binary.sizeBytes)))
    throw new Error(`agent-desktop ${version}'s archive has no ${build.binary.name} of its size`);
  await chmod(unpacked, 0o755);
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
  await pruneOlder(options.root, version);

  return { binary };
};

/** An older binary may still serve a running session; Unix keeps it open, Windows refuses. */
const pruneOlder = async (root: string, keep: string) => {
  const entries = await readdir(root);

  await Promise.all(
    entries
      .filter((name) => name !== keep)
      .map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {}))
  );
};
