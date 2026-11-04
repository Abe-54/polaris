/**
 * The config every git call the Daemon makes on its own runs with: a Workspace's
 * `.git/config` and hooks are its content, so none of the commands they name may
 * run (docs/adr/0056-automatic-git-runs-no-repository-commands.md).
 */
import { childEnv } from "../../service/childEnv.ts";
import { readBounded } from "../output.ts";
import { gitExecutable } from "../executable.ts";
import { groupFor, startSignal, stopOnAbort, uninterrupted } from "../interrupt.ts";
import {
  cacheKey,
  discoveryPaths,
  gitHome,
  hostCandidates,
  listedFiles,
  type Located,
  nativePath,
  ownFiles,
  type Stamped,
  stampAll,
} from "./discovery.ts";
import { NO_LAZY_FETCH, refuseLazyFetch } from "./lazyFetch.ts";
import {
  configEnv,
  type Entry,
  FIXED,
  HOST_SETTINGS,
  globalOptions,
  listingOptions,
  parseListing,
  repositoryEnv,
  repositoryOverrides,
  type SafeMode,
} from "./settings.ts";

export {
  globalOptions,
  hostConfigEnv,
  hostSettings,
  NO_HOOKS_PATH,
  noHooksPath,
  parseListing,
  repositoryEnv,
  repositoryOverrides,
  safeArgs,
} from "./settings.ts";

export { GitLazyFetchUnsupported, NO_LAZY_FETCH } from "./lazyFetch.ts";

export { hostSigning, type Signing } from "./signing.ts";

export type { SafeMode } from "./settings.ts";

type Env = Record<string, string | undefined>;

const LISTING_LIMIT = 1024 * 1024;

const decoder = new TextDecoder();

/** git with only the fixed settings: these reads run nothing a config names. */
const read = async (cwd: string, args: ReadonlyArray<string>, base: Env) => {
  const signal = startSignal(args);

  const proc = Bun.spawn([gitExecutable(base), ...args], {
    ...groupFor(signal),
    cwd,
    env: childEnv({ ...base, ...configEnv([...FIXED, ...HOST_SETTINGS], base), ...NO_LAZY_FETCH }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  stopOnAbort(proc, signal);

  const [stdout, stderr, code] = await Promise.all([
    readBounded(proc.stdout, LISTING_LIMIT, () => proc.kill("SIGKILL")),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout === null ? null : decoder.decode(stdout), stderr, code };
};

/** The config git itself reads for this call: its own discovery, env and options. */
const listConfig = async (cwd: string, options: ReadonlyArray<string>, base: Env) => {
  const listed = await read(
    cwd,
    [...options, "config", "--list", "--show-scope", "--show-origin", "-z"],
    base
  );

  // Fails closed: a listing cut short or refused could hide a driver.
  if (listed.stdout === null) {
    throw new Error("This repository's git config is too large to read safely");
  }

  if (listed.code !== 0) {
    throw new Error(`git could not read this repository's config: ${listed.stderr.trim()}`);
  }

  return parseListing(listed.stdout);
};

/** Where git finds the repository from `cwd`; null outside one, or in a bare one. */
const locate = async (cwd: string, options: ReadonlyArray<string>, base: Env) => {
  const flags = ["--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"];
  const found = await read(cwd, [...options, "rev-parse", ...flags], base);
  const [gitDir, commonDir, top] = (found.stdout ?? "").split("\n");

  if (found.code !== 0 || !gitDir || !commonDir || !top) return null;

  return {
    gitDir: nativePath(gitDir),
    commonDir: nativePath(commonDir),
    top: nativePath(top),
  } satisfies Located;
};

interface Cached {
  /** Stamped before the listing, then what the listing named. */
  readonly stamped: readonly [Stamped, Stamped];
  readonly stamps: string;
  readonly listing: ReadonlyArray<Entry>;
}

const stampsOf = ([before, named]: readonly [Stamped, Stamped]) =>
  JSON.stringify([stampAll(before), stampAll(named)]);

const cache = new Map<string, Cached>();

const CACHE_SIZE = 64;

/** The files `git var <name>` says git reads, "" for none; null when this git can't say. */
const askGitVar = async (cwd: string, options: ReadonlyArray<string>, name: string, base: Env) => {
  const out = await read(cwd, [...options, "var", name], base);

  if (out.code === 0) return out.stdout;

  return out.code === 1 && out.stderr === "" ? "" : null;
};

/** Which git runs, and the environment it finds its system and global config by. */
const HOST_CONFIG_ENV =
  /^(GIT_.*|PATH|HOME|XDG_CONFIG_HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMDATA)$/i;

const hostFiles = new Map<string, Promise<string | null>>();

/** `askGitVar`, once per git, options and environment: the answer names files, not their content. */
const filesGitReads = (cwd: string, options: ReadonlyArray<string>, name: string, base: Env) => {
  const env = Object.entries(base)
    .filter(([key]) => HOST_CONFIG_ENV.test(key))
    .sort(([a], [b]) => a.localeCompare(b));

  const key = JSON.stringify([name, options, env]);
  const known = hostFiles.get(key);

  if (known !== undefined) return known;
  // Shared by every caller: one caller's interrupt mustn't kill it for the rest.
  const asked = uninterrupted(() => askGitVar(cwd, options, name, base));

  if (hostFiles.size >= CACHE_SIZE) hostFiles.delete(hostFiles.keys().next().value ?? "");
  hostFiles.set(key, asked);
  // A failed read is asked again next time.
  void asked.then(
    (files) => files === null && hostFiles.delete(key),
    () => hostFiles.delete(key)
  );

  return asked;
};

/** Every config file git can read here, stamped before the listing so a change made meanwhile shows next time. */
const listAndCache = async (
  cwd: string,
  options: ReadonlyArray<string>,
  base: Env,
  key: string
) => {
  const [found, system, global] = await Promise.all([
    locate(cwd, options, base),
    filesGitReads(cwd, options, "GIT_CONFIG_SYSTEM", base),
    filesGitReads(cwd, options, "GIT_CONFIG_GLOBAL", base),
  ]);

  const discovery = found === null ? null : discoveryPaths(cwd, found);

  if (found === null || discovery === null || system === null || global === null) {
    return listConfig(cwd, options, base);
  }

  const candidates = hostCandidates(system, global);

  const before: Stamped = {
    paths: [...discovery.paths, ...ownFiles(found), ...candidates],
    heads: discovery.heads,
  };

  const stamps = stampAll(before);
  const listing = await listConfig(cwd, options, base);

  const extra = stamps === null ? null : listedFiles(found, listing, candidates, gitHome(base));

  if (extra === null) return listing;
  const again = await locate(cwd, options, base);
  const named: Stamped = { paths: extra, heads: [] };
  const extraStamps = stampAll(named);

  if (JSON.stringify(again) !== JSON.stringify(found) || extraStamps === null) return listing;

  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, {
    stamped: [before, named],
    stamps: JSON.stringify([stamps, extraStamps]),
    listing,
  });

  return listing;
};

const listingFor = async (cwd: string, args: ReadonlyArray<string>, base: Env) => {
  const options = listingOptions(globalOptions(args));
  const key = cacheKey(cwd, options, base);

  if (key === null) return listConfig(cwd, options, base);
  const cached = cache.get(key);

  if (cached !== undefined && stampsOf(cached.stamped) === cached.stamps) return cached.listing;
  cache.delete(key);

  return listAndCache(cwd, options, base, key);
};

/** The config a plain git call in `cwd` reads, as git lists it with each entry's scope. */
export const configListing = (cwd: string, base: Env) => listingFor(cwd, [], base);

/**
 * The environment for an automatic git call `args` in `cwd`: the fixed settings, every
 * command the repository's own config names turned off, and no lazy fetch. Rejects with
 * `GitLazyFetchUnsupported` for a partial clone when this git can't turn lazy fetch off.
 */
export const safeConfigEnv = async (
  cwd: string,
  base: Env,
  options: { readonly args?: ReadonlyArray<string>; readonly mode?: SafeMode } = {}
) => {
  const listing = await listingFor(cwd, options.args ?? [], base);
  const mode = options.mode ?? "safe";
  const overrides = repositoryOverrides(listing, mode);
  await refuseLazyFetch(listing, base);

  return {
    ...configEnv([...FIXED, ...HOST_SETTINGS, ...overrides], base),
    ...repositoryEnv(listing, mode, base),
    ...NO_LAZY_FETCH,
  };
};
