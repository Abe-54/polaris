/**
 * Where git itself found a cwd's repository, and a stamp of every path that
 * decided it or holds config git reads: a cached listing is used only while none changed.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Predicate } from "effect";
import { type Entry, REPOSITORY_SCOPES } from "./settings.ts";

export interface Located {
  readonly gitDir: string;
  readonly commonDir: string;
  readonly top: string;
}

/** Each of these makes git look elsewhere, or read config from elsewhere: never cached. */
const DISCOVERY_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
];

/** What a directory needs to be a repository to git (`is_git_directory`), or to hold one. */
const BELOW_TOP = [
  ".git",
  ".git/objects",
  ".git/refs",
  ".git/commondir",
  "objects",
  "refs",
  "commondir",
];

const HEADS_BELOW_TOP = [".git/HEAD", "HEAD"];

const INCLUDE = /^include(if\..+)?\.path$/;

/** Past this a file isn't hashed, and the listing isn't cached. */
const HASH_LIMIT = 1024 * 1024;

/** A file's owner and bytes; null when it is too large to hash, or grew while read. */
const readSmall = (path: string): { readonly uid: number; readonly bytes: Buffer } | null => {
  const fd = openSync(path, "r");

  try {
    const s = fstatSync(fd);

    if (s.size > HASH_LIMIT) return null;
    const bytes = Buffer.alloc(s.size + 1);
    let length = 0;

    for (let n = -1; n !== 0 && length < bytes.length; length += n) {
      n = readSync(fd, bytes, length, bytes.length - length, null);
    }

    return length > s.size ? null : { uid: s.uid, bytes: bytes.subarray(0, length) };
  } finally {
    closeSync(fd);
  }
};

/** A file's owner and a hash of its bytes. */
const fileStamp = (path: string): string | null => {
  const file = readSmall(path);

  if (file === null) return null;

  return `f${file.uid}:${createHash("sha256").update(file.bytes).digest("hex")}`;
};

/** A HEAD git takes (`validate_headref`), whichever branch or commit it names. */
const VALID_HEAD = /^(?:ref: refs\/[^\0\n]*|[0-9a-f]{40}|[0-9a-f]{64})\n?$/;

/** Discovery only asks whether a HEAD is valid: a checkout, or a commit on a detached HEAD, keeps it. */
const headStamp = (path: string): string | null => {
  const file = readSmall(path);

  if (file === null) return null;

  return VALID_HEAD.test(file.bytes.toString("latin1")) ? `h${file.uid}` : fileStamp(path);
};

const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

/** A directory by its identity and owner, a file by its content, `-` when absent; null: uncacheable. */
const stamp = (path: string, head = false): string | null => {
  try {
    // git takes a symlinked HEAD by where it points (`validate_headref`), never by what it holds.
    const link = head ? lstatSync(path) : null;

    if (link?.isSymbolicLink())
      return `l${link.uid}:${createHash("sha256").update(readlinkSync(path)).digest("hex")}`;
    const s = statSync(path);

    if (s.isDirectory()) return `d${s.ino}:${s.uid}`;

    return head ? headStamp(path) : fileStamp(path);
  } catch (error) {
    const absent = Predicate.hasProperty(error, "code") && ABSENT.has(String(error.code));

    return absent ? "-" : null;
  }
};

/** The paths a cached listing depends on: `heads` only as far as git's discovery reads them. */
export interface Stamped {
  readonly paths: ReadonlyArray<string>;
  readonly heads: ReadonlyArray<string>;
}

/** Null when any path can't be stamped: the caller doesn't cache, or lists again. */
export const stampAll = ({ paths, heads }: Stamped): string | null => {
  const stamps: Array<string> = [];

  const all = [
    ...paths.map((path) => [path, false] as const),
    ...heads.map((path) => [path, true] as const),
  ];

  for (const [path, head] of all) {
    const one = stamp(path, head);

    if (one === null) return null;
    stamps.push(one);
  }

  return JSON.stringify(stamps);
};

/** What `~` and the global config depend on (`gitHome`). */
const HOME_ENV = new Set(["HOME", "XDG_CONFIG_HOME", "HOMEDRIVE", "HOMEPATH", "USERPROFILE"]);

/** The cache key, or null when the call's options or environment move git's discovery. */
export const cacheKey = (
  cwd: string,
  options: ReadonlyArray<string>,
  base: Readonly<Record<string, string | undefined>>
): string | null => {
  if (
    options.some(
      (option, i) => option.startsWith("-") && option !== "-c" && options[i - 1] !== "-c"
    )
  ) {
    return null;
  }

  if (DISCOVERY_ENV.some((name) => (base[name] ?? "") !== "")) return null;

  const env = Object.entries(base)
    .filter(([name]) => name.startsWith("GIT_CONFIG") || HOME_ENV.has(name))
    .sort(([a], [b]) => a.localeCompare(b));

  return JSON.stringify([cwd, options, env]);
};

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where git takes `~` from: HOME, or on Windows without it, as Git for Windows sets it up,
 * %HOMEDRIVE%%HOMEPATH% when that folder exists, else %USERPROFILE%.
 */
export const gitHome = (
  env: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
  isDir: (path: string) => boolean = isDirectory
): string | undefined => {
  if (env.HOME !== undefined || platform !== "win32") return env.HOME;

  const share =
    env.HOMEDRIVE === undefined || env.HOMEPATH === undefined
      ? undefined
      : env.HOMEDRIVE + env.HOMEPATH;

  return share !== undefined && isDir(share) ? share : env.USERPROFILE;
};

/** Git for Windows prints `C:/forward/slashes`; stamps and comparisons need native paths. */
export const nativePath = (path: string): string =>
  process.platform === "win32" ? resolve(path) : path;

const isWithin = (dir: string, top: string) => dir === top || dir.startsWith(top + sep);

/** Every directory from `cwd` up to (not including) `top`: where git looked first and moved on. */
const levelsBelow = (cwd: string, top: string): Array<string> => {
  const levels: Array<string> = [];

  for (let dir = cwd; dir !== top; dir = dirname(dir)) levels.push(dir);

  return levels;
};

/** The repository's own config files: `config.worktree` whether or not `extensions.worktreeConfig` reads it. */
export const ownFiles = (found: Located): ReadonlyArray<string> => [
  join(found.commonDir, "config"),
  join(found.gitDir, "config.worktree"),
];

/**
 * The paths that decided `found`, or null when it isn't a plain repository
 * with `cwd` in its work tree (a bare one, `core.worktree`): no cache.
 */
export const discoveryPaths = (cwd: string, found: Located): Stamped | null => {
  let real: string;

  try {
    real = realpathSync(cwd);
  } catch {
    return null;
  }

  const { gitDir, top } = found;
  const dotGit = join(top, ".git");

  if (!isWithin(real, top) || (stamp(dotGit)?.startsWith("d") === true && dotGit !== gitDir)) {
    return null;
  }

  const levels = levelsBelow(real, top);

  return {
    paths: [
      ...levels.flatMap((dir) => BELOW_TOP.map((name) => join(dir, name))),
      dotGit,
      ...["objects", "refs", "commondir"].map((name) => join(gitDir, name)),
    ],
    heads: [
      ...levels.flatMap((dir) => HEADS_BELOW_TOP.map((name) => join(dir, name))),
      join(gitDir, "HEAD"),
    ],
  };
};

/**
 * The Host's config files git reads besides the repository's: `GIT_CONFIG_SYSTEM`
 * and `GIT_CONFIG_GLOBAL` as `git var` prints them, whether or not each exists yet.
 */
export const hostCandidates = (system: string, global: string): ReadonlyArray<string> =>
  [...system.split("\n"), ...global.split("\n")].flatMap((path) =>
    path === "" ? [] : [nativePath(path)]
  );

/** Where an include points, as git resolves it (relative to the including file); null: unknown. */
const includeTarget = (value: string, from: string | null, home: string | undefined) => {
  const homeKnown = home !== undefined && home !== "";

  if (value.startsWith("~/")) return homeKnown ? join(home, value.slice(2)) : null;

  if (value === "" || value.startsWith("~") || value.startsWith("%(")) return null;

  if (isAbsolute(value)) return value;

  return from === null ? null : resolve(dirname(from), value);
};

/**
 * The files git read beyond `candidates` that a cache must also stamp: what the
 * Host's config includes (found or not), git's built-in config (Apple's `unknown`
 * scope), and HEAD when an include depends on its branch. Null when `listing` came from anywhere else, or the repository's own config
 * includes a file: no cache.
 */
export const listedFiles = (
  found: Located,
  listing: ReadonlyArray<Entry>,
  candidates: ReadonlyArray<string>,
  home: string | undefined
): ReadonlyArray<string> | null => {
  const own = new Set(ownFiles(found));
  const extra = new Set<string>();

  // git names its own config relative to the top level, where it runs.
  const file = (e: Entry) =>
    e.origin.startsWith("file:") ? resolve(found.top, e.origin.slice(5)) : null;

  for (const e of listing) {
    if (!INCLUDE.test(e.key)) continue;
    const target = REPOSITORY_SCOPES.has(e.scope) ? null : includeTarget(e.value, file(e), home);

    if (target === null) return null;
    extra.add(target);
  }

  for (const e of listing) {
    const path = file(e);

    if (e.scope === "unknown" && path !== null) extra.add(path);
  }

  const read = new Set([...candidates, ...extra]);

  const covered = listing.every((e) => {
    const path = file(e);

    if (REPOSITORY_SCOPES.has(e.scope)) return own.has(path ?? "");

    return path === null ? e.origin === "command line:" : read.has(path);
  });

  if (!covered) return null;

  // Which branch HEAD names decides whether git reads an `onbranch:` include: stamped exactly.
  const onBranch = listing.some((e) => e.key.startsWith("includeif.onbranch:"));

  return onBranch ? [...extra, join(found.gitDir, "HEAD")] : [...extra];
};
