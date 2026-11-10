/**
 * The one way the Daemon runs git: the Host's own `git` CLI and credentials, no JS
 * git. Calls run with `safeConfig/`'s settings unless they're git the user asked for.
 */
import { childEnv } from "../service/childEnv.ts";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ServiceError } from "../services.ts";
import { megabytes, readBounded, readHead } from "./output.ts";
import { gitExecutable } from "./executable.ts";
import { hostConfigEnv, NO_HOOKS_PATH, safeArgs, safeConfigEnv } from "./safeConfig/index.ts";
import { killTree, ownProcessGroup } from "../platform/processes.ts";
import { groupFor, interruptibleGit, pipesOf, startSignal, stopOnAbort } from "./interrupt.ts";

export interface GitResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: string;
}

export interface GitOptions {
  /** Extra environment on top of the Daemon's own (e.g. `GIT_INDEX_FILE`). */
  readonly env?: Record<string, string>;
  readonly stdin?: Uint8Array | string;
  /** Treat these exit codes as success (e.g. `git diff --no-index` exits 1 on differences). */
  readonly okCodes?: ReadonlyArray<number>;
  /** Kill git (SIGKILL) after this long; it then fails with exit code 137 or similar. */
  readonly timeoutMs?: number;
  /**
   * Aborting sends SIGTERM to git's process group (git removes its lock files, ssh stops
   * too), then SIGKILL. Work under `interruptibleGit`/`finishingGit` is aborted on interrupt.
   */
  readonly signal?: AbortSignal;
  /**
   * `"host"` is git the user asked for (commit, sync, Accept, stage): the Host's
   * config and hooks as they are. The default turns off everything that runs a command;
   * `"trusted-fetch"` (a Review fetch in a trusted Workspace) keeps its ssh command, proxy and helpers.
   */
  readonly config?: "safe" | "trusted-fetch" | "host";
  /** Stop git once stdout passes this; it then fails with `GitOutputTooLarge`. */
  readonly maxOutputBytes?: number;
}

/** What any one git call may print: far past real metadata, well short of the Daemon's memory. */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

const MAX_STDERR_BYTES = 64 * 1024;

/** git printed more than its caller's limit; it was killed before the rest was read. */
export class GitOutputTooLarge extends Error {
  constructor(
    readonly args: ReadonlyArray<string>,
    readonly limit: number,
    message = `git's output passed ${megabytes(limit)}, so Polaris stopped it`
  ) {
    super(message);
  }
}

/**
 * Environment every git call gets: never prompt for credentials (there is no
 * TTY), never take optional locks (a background `git status` must not fight
 * the user's own git for `index.lock`), and a stable locale for parsing.
 */
export const baseEnv = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
});

/** git and what it started; on Windows a forced kill, which can leave git's lock files behind. */
const killGroup = (pid: number) => void killTree(pid, "SIGTERM");

/** A repository's own hooks never run in a checkout Polaris makes (a relative husky `core.hooksPath`). */
export const HOOKS_OFF: ReadonlyArray<string> = ["-c", `core.hooksPath=${NO_HOOKS_PATH}`];

export const runGitRaw = async (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {}
): Promise<GitResult> => {
  const host = options.config === "host";
  const base = { ...baseEnv(), ...options.env };
  const mode = options.config === "trusted-fetch" ? "trusted-fetch" : "safe";
  const safe = host ? hostConfigEnv(base) : await safeConfigEnv(cwd, base, { args, mode });

  const spawnOptions: Bun.SpawnOptions.OptionsObject<"ignore" | Blob, "pipe", "pipe"> = {
    cwd,
    env: childEnv({ ...base, ...safe }),
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  };

  if (options.timeoutMs !== undefined) {
    spawnOptions.timeout = options.timeoutMs;
    spawnOptions.killSignal = "SIGKILL";
  }

  const signal = startSignal(args, options.signal);

  const proc = Bun.spawn([gitExecutable(base), ...(host ? args : safeArgs(args))], {
    ...spawnOptions,
    ...groupFor(signal),
  });

  const overflow = () => {
    if (signal !== undefined) killGroup(proc.pid);

    // taskkill needs git alive to find its children, and ends git with them.
    if (signal === undefined || ownProcessGroup()) proc.kill("SIGKILL");
  };

  stopOnAbort(proc, signal);

  const limit = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  const reads = Promise.all([
    readBounded(proc.stdout, limit, overflow),
    readHead(proc.stderr, MAX_STDERR_BYTES),
  ]);

  const [stdout, stderr] = await pipesOf(reads, proc.exited, signal, [new Uint8Array(), ""]);
  const code = await proc.exited;

  if (stdout === null) throw new GitOutputTooLarge(args, limit);

  return { code, stdout, stderr };
};

export class GitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: ReadonlyArray<string>,
    readonly code: number,
    readonly stderr: string
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

/** Runs git; rejects with `GitCommandError` on a non-success exit code. */
export const runGit = async (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {}
): Promise<GitResult> => {
  const result = await runGitRaw(cwd, args, options);
  const ok = result.code === 0 || (options.okCodes?.includes(result.code) ?? false);

  if (!ok) throw new GitCommandError(cwd, args, result.code, result.stderr);

  return result;
};

const decoder = new TextDecoder();

/** Runs git and returns stdout as text with the trailing newline trimmed. */
export const gitText = async (
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {}
): Promise<string> => decoder.decode((await runGit(cwd, args, options)).stdout).replace(/\n$/, "");

const gitFailure = (cause: unknown) =>
  new ServiceError({
    service: "git",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/** Read-only `git` as an Effect, failing with `ServiceError`; an interrupt kills it. */
export const git = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  interruptibleGit({ try: () => runGit(cwd, args, options), catch: gitFailure });

export const gitTextEffect = (cwd: string, args: ReadonlyArray<string>, options: GitOptions = {}) =>
  interruptibleGit({ try: () => gitText(cwd, args, options), catch: gitFailure });

/**
 * Whether `cwd` could be inside a git work tree: some directory from `cwd` up
 * has a `.git` (a directory, or the file a worktree or submodule has). When
 * none does, git can't find a work tree either, so callers skip spawning it.
 * With `GIT_DIR` or `GIT_WORK_TREE` set, git doesn't look for `.git`: always
 * true then.
 */
export const mayBeInWorkTree = (cwd: string): boolean => {
  if (process.env.GIT_DIR !== undefined || process.env.GIT_WORK_TREE !== undefined) return true;
  let dir = resolve(cwd);

  for (;;) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);

    if (parent === dir) return false;
    dir = parent;
  }
};

/** Git for Windows prints C:/forward/slashes; the Daemon's paths are native. */
export const nativePath = (path: string): string =>
  process.platform === "win32" ? resolve(path) : path;

/** The repository's top level, or null when `cwd` is not inside a git work tree. */
export const findRepoRoot = async (cwd: string): Promise<string | null> => {
  if (!mayBeInWorkTree(cwd)) return null;
  const result = await runGitRaw(cwd, ["rev-parse", "--show-toplevel"]).catch(() => null);

  if (result === null || result.code !== 0) return null;
  const root = decoder.decode(result.stdout).trim();

  if (root === "") return null;

  return nativePath(root);
};

/** The HEAD commit, or null on an unborn branch. */
export const resolveHead = async (cwd: string): Promise<string | null> => {
  const result = await runGitRaw(cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);

  return result.code === 0 ? decoder.decode(result.stdout).trim() : null;
};

/** Resolves a ref to a commit, or null when it doesn't exist. */
export const resolveCommit = async (cwd: string, ref: string): Promise<string | null> => {
  const result = await runGitRaw(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

  return result.code === 0 ? decoder.decode(result.stdout).trim() : null;
};

/** The empty tree for this repository's hash algorithm (sha1 or sha256). */
export const emptyTree = (cwd: string): Promise<string> =>
  gitText(cwd, ["hash-object", "-t", "tree", "--stdin"], { stdin: "" });
