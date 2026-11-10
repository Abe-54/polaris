/**
 * The search backend used when fff's native library can't load (or is turned
 * off with `POLARIS_FFF=off`): a file list from `git ls-files` (or a walk
 * outside git), a subsequence fuzzy scorer, `git grep`, and `fs.watch`.
 * Slower and not typo-tolerant, but dependency-free.
 */
import { childEnv } from "../../service/childEnv.ts";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { baseEnv, findRepoRoot, runGit } from "../../git/git.ts";
import { safeConfigEnv } from "../../git/safeConfig/index.ts";
import { gitExecutable } from "../../git/executable.ts";
import { groupFor, startSignal, stopOnAbort, uninterrupted } from "../../git/interrupt.ts";
import type { FileChange, GrepHit, GrepQuery, PathHit, SearchBackend } from "./types.ts";
import { WALK_SKIP, watchRoot } from "./watch.ts";
import { readLines } from "../../lines.ts";

/** Cap on files considered by the walk outside git repositories. */
const WALK_MAX_FILES = 200_000;

/** How long a file list is reused before it is rebuilt. */
const LIST_TTL_MS = 5_000;

/** Batch window for fs.watch events. */
const WATCH_BATCH_MS = 50;

/**
 * `git grep` threads. git defaults to one per core, but on macOS opening many
 * small files in parallel contends in the kernel: on a 12-core M2 Max a
 * 50k-file tree greps in ~1.3 s with 12 threads, ~0.72 s with 6 and ~0.93 s
 * with 2, so half the cores (2–8) is near the best there. Elsewhere git's
 * default stands (null).
 */
export const gitGrepThreads = (
  platform: NodeJS.Platform = process.platform,
  cores: number = availableParallelism()
): number | null =>
  platform === "darwin" ? Math.min(8, Math.max(2, Math.floor(cores / 2))) : null;

const isSeparator = (c: string | undefined) =>
  c === undefined || c === "/" || c === "_" || c === "-" || c === "." || c === " ";

const matchFrom = (
  query: string,
  candidate: string,
  lower: string,
  from: number
): number | null => {
  let score = 0;
  let at = from;
  let previous = -2;

  for (const q of query) {
    const found = lower.indexOf(q, at);

    if (found < 0) return null;
    score += 1;

    if (found === previous + 1) score += 5;
    const before = candidate[found - 1];
    const here = candidate[found]!;

    if (isSeparator(before)) score += 8;
    else if (before !== undefined && before === before.toLowerCase() && here !== here.toLowerCase())
      score += 6;
    score -= Math.min(found - at, 10) * 0.1;
    previous = found;
    at = found + 1;
  }

  return score;
};

/**
 * Subsequence fuzzy score of `query` against a relative path, or null when it
 * doesn't match. Consecutive runs, word starts and matches inside the file
 * name score higher; longer paths score slightly lower.
 */
export const fuzzyScore = (query: string, path: string): number | null => {
  const q = query.toLowerCase().replace(/\s+/g, "");

  if (q === "") return 0;
  const lower = path.toLowerCase();
  const slash = path.lastIndexOf("/");
  const inName = matchFrom(q, path, lower, slash + 1);
  const anywhere = matchFrom(q, path, lower, 0);

  if (anywhere === null) return null;
  const best = inName !== null ? Math.max(inName + q.length * 2, anywhere) : anywhere;

  return best - path.length * 0.01;
};

const walk = async (root: string): Promise<Array<string>> => {
  const out: Array<string> = [];
  const stack = [root];

  while (stack.length > 0 && out.length < WALK_MAX_FILES) {
    const dir = stack.pop()!;
    let entries: Array<import("node:fs").Dirent>;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name)) stack.push(join(dir, entry.name));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(root, join(dir, entry.name)));
      }
    }
  }

  return out;
};

/** Files under `root`, relative to it: tracked plus untracked-not-ignored inside git. */
export const listFiles = async (root: string, inRepo?: boolean): Promise<Array<string>> => {
  if (inRepo ?? (await findRepoRoot(root)) !== null) {
    const { stdout } = await runGit(root, ["ls-files", "-z", "-co", "--exclude-standard"]);

    return new TextDecoder()
      .decode(stdout)
      .split("\0")
      .filter((p) => p !== "");
  }

  return walk(root);
};

class RegexFlavourUnsupported extends Error {}

/**
 * Runs `git grep` (with `--no-index` outside repositories) and stops after
 * `limit` hits. Regexes use PCRE (`-P`, closest to fff's Rust regex syntax)
 * when git was built with it, else POSIX extended (`-E`).
 */
export const gitGrep = async (
  root: string,
  query: GrepQuery,
  knownInRepo?: boolean
): Promise<Array<GrepHit>> => {
  if (query.limit <= 0) return [];
  const inRepo = knownInRepo ?? (await findRepoRoot(root)) !== null;

  if (!query.regex) return runGitGrep(root, inRepo, "-F", query);

  try {
    return await runGitGrep(root, inRepo, "-P", query);
  } catch (cause) {
    if (cause instanceof RegexFlavourUnsupported) return runGitGrep(root, inRepo, "-E", query);
    throw cause;
  }
};

type GrepFlavour = "-F" | "-E" | "-P";

const gitGrepArgs = (inRepo: boolean, flavour: GrepFlavour, query: GrepQuery) => {
  const threads = gitGrepThreads();

  return [
    "grep",
    ...(threads === null ? [] : ["--threads", String(threads)]),
    "-n",
    "--column",
    "-z",
    "-I",
    "--no-color",
    ...(inRepo ? ["--untracked"] : ["--no-index", "--exclude-standard"]),
    flavour,
    ...(query.caseSensitive ? [] : ["-i"]),
    "-e",
    query.pattern,
    "--",
    ".",
  ];
};

const runGitGrep = async (
  root: string,
  inRepo: boolean,
  flavour: GrepFlavour,
  query: GrepQuery
): Promise<Array<GrepHit>> => {
  const args = gitGrepArgs(inRepo, flavour, query);
  const env = childEnv({ ...baseEnv(), ...(await safeConfigEnv(root, baseEnv())) });
  // An interrupted search ends its git grep, and whatever git started, with it.
  const signal = startSignal(args);

  const proc = Bun.spawn([gitExecutable(), ...args], {
    ...groupFor(signal),
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  stopOnAbort(proc, signal);

  const hits: Array<GrepHit> = [];

  const parseLine = (line: string) => {
    const [path, lineNo, column, ...rest] = line.split("\0");

    if (path === undefined || lineNo === undefined || column === undefined) return;
    hits.push({
      path: join(root, path),
      line: Number(lineNo),
      column: Number(column),
      text: rest.join("\0"),
    });
  };

  for await (const line of readLines(proc.stdout, { unterminated: true })) {
    parseLine(line);

    if (hits.length >= query.limit) {
      proc.kill();
      break;
    }
  }

  const code = await proc.exited;

  // 0 = matches, 1 = none; anything else (bad regex, …) is an error unless we killed it.
  if (code > 1 && hits.length < query.limit) {
    const stderr = (await new Response(proc.stderr).text()).trim();

    if (flavour === "-P" && /PCRE|perl/i.test(stderr)) throw new RegexFlavourUnsupported(stderr);
    throw new Error(stderr || `git grep exited ${code}`);
  }

  return hits.slice(0, query.limit);
};

export const openFallbackBackend = (root: string): SearchBackend => {
  // Whether `root` is inside a repository, looked up again at most every LIST_TTL_MS.
  let repo: { at: number; inRepo: Promise<boolean> } | null = null;

  const inRepo = () => {
    if (repo === null || Date.now() - repo.at > LIST_TTL_MS) {
      // Shared by every caller, so no one caller's interrupt may end it.
      repo = {
        at: Date.now(),
        inRepo: uninterrupted(() => findRepoRoot(root).then((r) => r !== null)),
      };
    }

    return repo.inRepo;
  };

  let cached: { at: number; files: Promise<Array<string>> } | null = null;

  const files = () => {
    if (cached === null || Date.now() - cached.at > LIST_TTL_MS) {
      cached = {
        at: Date.now(),
        files: uninterrupted(() => inRepo().then((r) => listFiles(root, r))),
      };
      cached.files.catch(() => {
        cached = null;
      });
    }

    return cached.files;
  };

  const watchers = new Set<() => void>();

  return {
    kind: "fallback",
    root,
    searchPaths: async (query, limit) => {
      const hits: Array<PathHit> = [];

      for (const path of await files()) {
        const score = fuzzyScore(query, path);

        if (score !== null) hits.push({ path: join(root, path), score });
      }

      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },
    grep: async (query) => gitGrep(root, query, await inRepo()),
    watch: async (onBatch) => {
      let pending = new Map<string, FileChange>();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const flush = () => {
        timer = undefined;
        const batch = [...pending.values()];
        pending = new Map();

        if (batch.length > 0) onBatch(batch);
      };

      const close = await watchRoot(root, (event, path) => {
        // fs.watch can't tell created from deleted; look at the file system.
        const kind = event === "change" ? "modified" : existsSync(path) ? "created" : "deleted";
        const previous = pending.get(path);
        pending.set(path, {
          path,
          kind: previous?.kind === "created" && kind === "modified" ? "created" : kind,
        });
        cached = null;
        timer ??= setTimeout(flush, WATCH_BATCH_MS);
      });

      const stop = () => {
        clearTimeout(timer);
        close();
        watchers.delete(stop);
      };

      watchers.add(stop);

      return stop;
    },
    dispose: () => {
      for (const stop of watchers) stop();
    },
  };
};
