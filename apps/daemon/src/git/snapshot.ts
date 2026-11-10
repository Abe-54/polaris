/**
 * Working-tree snapshots through an index of Polaris's own.
 *
 * Design follows pingdotgg/t3code@de251fc (MIT): point `GIT_INDEX_FILE` at an
 * index that isn't the user's, `git add -A`, `git write-tree`. The user's
 * index, HEAD and branch are never written. No code was copied.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitText, mayBeInWorkTree, nativePath, resolveHead, runGitRaw } from "./git.ts";
import { holdsNoGitlinks } from "./indexFile.ts";

export interface Snapshot {
  /** The repository top level the snapshot was taken from. */
  readonly root: string;
  /** Tree of the working tree: tracked and untracked files, minus ignored ones. */
  readonly tree: string;
  /** HEAD at the time of the snapshot; null on an unborn branch. */
  readonly head: string | null;
}

interface Repo {
  readonly root: string;
  /** The user's index (of this worktree). Read, never written. */
  readonly userIndex: string;
  /** Polaris's own index for this worktree: `<git dir>/polaris/index`. */
  readonly ownIndex: string;
  /** An object name's bytes in this repository's indexes; null when git didn't say (before 2.25). */
  readonly hashBytes: number | null;
}

const HASH_BYTES = new Map([
  ["sha1", 20],
  ["sha256", 32],
]);

/**
 * Never split an index of ours: with the user's `core.splitIndex`, writing it
 * would add `sharedindex.*` files to the git dir and expire old ones there.
 */
const INDEX_CONFIG = ["-c", "core.splitIndex=false"];

/**
 * Config for commands on Polaris's own index: also skip the trailing SHA over
 * the whole index on every write (git ≥ 2.40; older versions ignore the key).
 * Only our own git calls ever read this index.
 */
const OWN_INDEX_CONFIG = [...INDEX_CONFIG, "-c", "index.skipHash=true"];

/** An `index.lock` older than this was left by a crashed Daemon. */
const STALE_LOCK_MS = 60_000;

const decoder = new TextDecoder();

/** Repository paths by cwd. Only positive answers are kept; a failure drops the entry. */
const repos = new Map<string, Repo>();

const discover = async (cwd: string): Promise<Repo | null> => {
  const cached = repos.get(cwd);

  if (cached !== undefined) return cached;

  if (!mayBeInWorkTree(cwd)) return null;

  // One process for the top level, both index paths (per worktree) and the hash.
  const result = await runGitRaw(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-path",
    "index",
    "--git-path",
    "polaris/index",
    "--show-object-format",
  ]).catch(() => null);

  if (result === null || result.code !== 0) return null;
  const [top, userIndex, ownIndex, format] = decoder.decode(result.stdout).split("\n");

  if (!top || !userIndex || !ownIndex) return null;
  const hashBytes = HASH_BYTES.get(format ?? "") ?? null;
  const repo = { root: nativePath(top), userIndex, ownIndex, hashBytes };
  repos.set(cwd, repo);

  return repo;
};

/**
 * The user's index this repository's own index was last seeded from, as a
 * stat signature. git replaces the index file on every write (new inode,
 * new mtime), so a different signature means the user's index changed.
 */
const seeds = new Map<string, string | null>();

const signature = async (path: string): Promise<string | null> => {
  const s = await stat(path, { bigint: true }).catch(() => null);

  return s === null ? null : `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
};

/** One snapshot at a time per index (git would refuse a second with `index.lock`). */
const queues = new Map<string, Promise<unknown>>();

const serialized = <A>(key: string, task: () => Promise<A>): Promise<A> => {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });

  return run;
};

/**
 * Copies the user's index to `to`, keeping its mtime: git treats entries
 * modified in the same instant as the index ("racily clean") as suspect and
 * rehashes them. A fresh mtime would make a same-size edit look unchanged and
 * drop it.
 */
const copyUserIndex = async (userIndex: string, to: string): Promise<void> => {
  await copyFile(userIndex, to);
  const { atimeMs, mtimeMs } = await stat(userIndex);
  await utimes(to, atimeMs / 1000, Math.floor(mtimeMs) / 1000);
};

/** False only when the index was read to its end and holds no gitlink; anything else costs a listing. */
const mayHoldGitlinks = async (index: string, hashBytes: number | null) => {
  if (hashBytes === null) return true;
  const bytes = await readFile(index).catch(() => null);

  return bytes === null || !holdsNoGitlinks(bytes, hashBytes);
};

/** The index's submodules (gitlinks), as `add -A` excludes: it would run git inside each one. */
const gitlinkExclusions = async (repo: Repo, env: { readonly GIT_INDEX_FILE: string }) => {
  if (!(await mayHoldGitlinks(env.GIT_INDEX_FILE, repo.hashBytes))) return [];
  const listed = await runGitRaw(repo.root, ["ls-files", "-s", "-z"], { env });

  if (listed.code !== 0) return [];

  return decoder
    .decode(listed.stdout)
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .map((entry) => `:(exclude,literal)${entry.slice(entry.indexOf("\t") + 1)}`);
};

/** `add -A` into `index`, then its tree, and whether `write-tree` rewrote the index to get it. */
const addAndWriteTree = async (repo: Repo, index: string, config: ReadonlyArray<string>) => {
  const env = { GIT_INDEX_FILE: index };
  const excluded = await gitlinkExclusions(repo, env);
  const add = [...config, "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"];

  // A submodule's recorded commit stays as the index has it.
  await gitText(repo.root, add, { env, stdin: [".", ...excluded].join("\0") });
  const added = await signature(index);
  const tree = await gitText(repo.root, [...config, "write-tree"], { env });

  return { tree, rewritten: added !== null && (await signature(index)) !== added };
};

/**
 * The tree of the working tree through Polaris's own index, which persists
 * between snapshots so that git's stat cache stays warm: `add -A` rehashes
 * only files that changed since the last snapshot, whatever the user's index
 * says. It is (re)seeded from the user's index whenever that changes, so
 * which files count as tracked (and so are kept even if ignored) always
 * follows the user's index, as with a fresh copy.
 */
const ownIndexTree = async (repo: Repo): Promise<string> => {
  const seed = await signature(repo.userIndex);

  if (seeds.get(repo.ownIndex) !== seed || !existsSync(repo.ownIndex)) {
    seeds.delete(repo.ownIndex);
    await mkdir(dirname(repo.ownIndex), { recursive: true });
    await rm(repo.ownIndex, { force: true });

    if (seed !== null) await copyUserIndex(repo.userIndex, repo.ownIndex);
  }

  const lock = `${repo.ownIndex}.lock`;
  const lockStat = await stat(lock).catch(() => null);

  if (lockStat !== null && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
    await rm(lock, { force: true });
  }

  const { tree, rewritten } = await addAndWriteTree(repo, repo.ownIndex, OWN_INDEX_CONFIG);

  // An index left as it was gave its cached tree, which gc may have pruned (ADR 0109):
  // a missing tree throws and takes the fallback.
  if (!rewritten) await gitText(repo.root, ["cat-file", "-e", `${tree}^{tree}`]);
  seeds.set(repo.ownIndex, seed);

  return tree;
};

/** The tree through a throwaway copy of the user's index (the fallback). */
const tempIndexTree = async (repo: Repo): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "polaris-index-"));

  try {
    const index = join(dir, "index");

    if (existsSync(repo.userIndex)) await copyUserIndex(repo.userIndex, index);

    return (await addAndWriteTree(repo, index, INDEX_CONFIG)).tree;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const snapshotRepo = async (repo: Repo): Promise<Snapshot> => {
  const [tree, head] = await Promise.all([
    serialized(repo.ownIndex, () =>
      ownIndexTree(repo).catch(async () => {
        // Our own index is only a cache: drop it and take this snapshot the slow way.
        seeds.delete(repo.ownIndex);
        await rm(repo.ownIndex, { force: true }).catch(() => {});

        return tempIndexTree(repo);
      })
    ),
    resolveHead(repo.root),
  ]);

  return { root: repo.root, tree, head };
};

/**
 * Snapshots the working tree of the repository containing `cwd`. Returns null
 * outside git repositories.
 */
export const snapshotWorkingTree = async (cwd: string): Promise<Snapshot | null> => {
  const repo = await discover(cwd);

  if (repo === null) return null;

  try {
    return await snapshotRepo(repo);
  } catch (cause) {
    // The repository may have moved or gone: look again once.
    repos.delete(cwd);
    const again = await discover(cwd);

    if (again === null) return null;

    if (again.root === repo.root && again.ownIndex === repo.ownIndex) throw cause;

    return snapshotRepo(again);
  }
};

/** Forgets cached repository paths and seeds (tests). */
export const resetSnapshotCaches = (): void => {
  repos.clear();
  seeds.clear();
};
