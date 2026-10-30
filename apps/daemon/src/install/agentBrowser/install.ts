/**
 * Installs the pinned agent-browser into `<root>/<version>/` with the managed model server's
 * verified download (size-bounded, SHA-256 checked, atomic rename), then drops older versions.
 */
import { chmod, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PinnedFile } from "../../prediction/managed/catalog.ts";
import { downloadFile, type Fetcher } from "../../prediction/managed/download.ts";
import { AGENT_BROWSER_ASSETS, AGENT_BROWSER_VERSION } from "./pin.ts";

export interface InstallOptions {
  /** Holds one directory per installed version. */
  readonly root: string;
  /** `runtimePlatform()`: `<os>-<arch>`, plus `-musl` on a musl Linux. */
  readonly platform: string;
  readonly version?: string;
  readonly assets?: Readonly<Record<string, PinnedFile>>;
  readonly fetch?: Fetcher;
  readonly signal?: AbortSignal;
}

export interface InstalledAgentBrowser {
  readonly binary: string;
}

/** The platform has no agent-browser build, or none was pinned. */
export class NoAgentBrowserBuild extends Error {}

const pinnedFor = (options: InstallOptions) => {
  const version = options.version ?? AGENT_BROWSER_VERSION;
  const assets: Readonly<Record<string, PinnedFile>> = options.assets ?? AGENT_BROWSER_ASSETS;
  const file = Object.hasOwn(assets, options.platform) ? assets[options.platform] : undefined;

  if (file === undefined)
    throw new NoAgentBrowserBuild(`no agent-browser build for ${options.platform}`);

  return { version, file, dir: join(options.root, version) };
};

/**
 * The pinned binary if it is already in place, by size alone: `downloadFile` renames a file
 * there only after its hash matched, so this costs one `stat`.
 */
export const installedOnDisk = async (
  options: InstallOptions
): Promise<InstalledAgentBrowser | null> => {
  const { file, dir } = pinnedFor(options);
  const binary = join(dir, file.name);
  const info = await stat(binary).catch(() => null);

  return info?.isFile() === true && info.size === file.sizeBytes ? { binary } : null;
};

export const installAgentBrowser = async (
  options: InstallOptions
): Promise<InstalledAgentBrowser> => {
  const { version, file, dir } = pinnedFor(options);
  await downloadFile({
    file,
    dir,
    fetch: options.fetch ?? fetch,
    signal: options.signal ?? new AbortController().signal,
    onProgress: () => {},
  });
  const binary = join(dir, file.name);
  await chmod(binary, 0o755);
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
