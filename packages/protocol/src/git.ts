/**
 * Git errors, the Changes tab's writes (capability `git.write`), `git.watch` and `git.log`;
 * `git.status`, `git.diff` and `git.show` stay in `rpc.ts`.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  cwd: Schema.String,
  message: Schema.String,
}) {}

/** Paths relative to the repository's top level, as `git.status` reports them. */
const GitPaths = { cwd: Schema.String, paths: Schema.Array(Schema.String) };

/** Stages the paths' changes, deletions included (capability `git.write`). */
export const GitStage = Rpc.make("git.stage", {
  payload: GitPaths,
  success: Schema.Void,
  error: GitError,
});

/** Takes the paths out of the index, back to HEAD (capability `git.write`). */
export const GitUnstage = Rpc.make("git.unstage", {
  payload: GitPaths,
  success: Schema.Void,
  error: GitError,
});

/**
 * Puts tracked paths' unstaged changes back to the index's version (capability
 * `git.write`). Untracked files are the Client's to trash; they are refused here.
 */
export const GitDiscard = Rpc.make("git.discard", {
  payload: GitPaths,
  success: Schema.Void,
  error: GitError,
});

/** What `git.commit` streams: the hooks' output as it comes, then how it ended. */
export const GitCommitItem = Schema.TaggedUnion({
  Output: { text: Schema.String },
  Committed: { head: Schema.String },
  /** git (or a hook) refused; `Output` already carried why. */
  Failed: { exitCode: Schema.Int },
});

export type GitCommitItem = typeof GitCommitItem.Type;

/**
 * Commits the index with `message`, running the repository's hooks (capability
 * `git.write`). The commit runs to its end even when the stream is dropped.
 */
export const GitCommit = Rpc.make("git.commit", {
  payload: { cwd: Schema.String, message: Schema.String },
  success: GitCommitItem,
  error: GitError,
  stream: true,
});

/**
 * One item each time git's own state moves for `cwd`'s checkout: its index, HEAD, HEAD's reflog
 * or packed refs (capability `git.watch`). The working tree's edits come from `files.watch`.
 */
export const GitWatch = Rpc.make("git.watch", {
  payload: { cwd: Schema.String },
  success: Schema.Null,
  error: GitError,
  stream: true,
});

export class GitWatchRpcs extends RpcGroup.make(GitWatch) {}

/** One commit as `git.log` reads it; `date` is the author date, ISO-8601. */
export class GitLogCommit extends Schema.Class<GitLogCommit>("GitLogCommit")({
  sha: Schema.String,
  subject: Schema.String,
  /** The message after the subject line, trailing newlines trimmed; empty when there is none. */
  body: Schema.String,
  author: Schema.String,
  date: Schema.String,
}) {}

/** The most `git.log` answers in one call. */
export const MAX_GIT_LOG = 100;

/**
 * The newest `limit` commits reachable from HEAD at `cwd`, newest first (capability `git.log`);
 * empty on an unborn branch. Read-only: no hook or config command runs.
 */
export const GitLog = Rpc.make("git.log", {
  payload: {
    cwd: Schema.String,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_GIT_LOG })),
  },
  success: Schema.Struct({ commits: Schema.Array(GitLogCommit) }),
  error: GitError,
});

export class GitLogRpcs extends RpcGroup.make(GitLog) {}

/**
 * How the branch stands against its upstream, beside `git.status`'s ahead and
 * behind (capability `git.sync`). Older Daemons leave it out.
 */
export const GitTracking = Schema.Struct({
  /** The upstream as git names it ("origin/main"); null when the branch has none. */
  upstream: Schema.NullOr(Schema.String),
  /** The upstream is configured but its branch is gone from the remote. */
  gone: Schema.Boolean,
  /** Where Publish branch pushes (origin, else the first remote); null with an upstream or no remote. */
  remote: Schema.NullOr(Schema.String),
});

export type GitTracking = typeof GitTracking.Type;

/**
 * What `git.sync` does. Pull follows the repository's pull.rebase / pull.ff and
 * is `--ff-only` when neither is set; push goes to the upstream, publish is
 * `push -u` to the remote; sync pulls, then pushes what's ahead. Never forced.
 */
export const GitSyncAction = Schema.Literals(["fetch", "pull", "push", "publish", "sync"]);

export type GitSyncAction = typeof GitSyncAction.Type;

/** Why a sync stopped, so the Client can say what to do next. */
export const GitSyncFailure = Schema.Literals([
  "no-remote",
  "no-upstream",
  "detached",
  /** Pull can't fast-forward and the repository sets no other way to pull. */
  "diverged",
  /** The remote refused a push that isn't a fast-forward. */
  "rejected",
  "conflicts",
  /** Pulling would overwrite uncommitted changes. */
  "local-changes",
  "auth",
  "network",
  "timeout",
  "failed",
]);

export type GitSyncFailure = typeof GitSyncFailure.Type;

export const GitSyncStep = Schema.Literals(["fetch", "pull", "push"]);

export type GitSyncStep = typeof GitSyncStep.Type;

/** What `git.sync` streams: each step as it starts, then how it ended. */
export const GitSyncItem = Schema.TaggedUnion({
  Step: { step: GitSyncStep, remote: Schema.String },
  Done: {},
  /** `output` is git's own words (its last lines). */
  Failed: { reason: GitSyncFailure, exitCode: Schema.NullOr(Schema.Int), output: Schema.String },
});

export type GitSyncItem = typeof GitSyncItem.Type;

/**
 * Fetches, pulls or pushes the branch checked out at `cwd` (capability
 * `git.sync`), never prompting for credentials. Closing the stream stops git.
 */
export const GitSync = Rpc.make("git.sync", {
  payload: { cwd: Schema.String, action: GitSyncAction },
  success: GitSyncItem,
  error: GitError,
  stream: true,
});

/**
 * Makes `path` a git repository with the Host's own git config, then an empty first commit so
 * Worktrees can branch from it (capability `git.init`). `head` is null, with git's words in
 * `note`, when git refused that commit (no identity set, say); the repository stays.
 */
export const GitInit = Rpc.make("git.init", {
  payload: { path: Schema.String },
  success: Schema.Struct({
    head: Schema.NullOr(Schema.String),
    note: Schema.NullOr(Schema.String),
  }),
  error: GitError,
});

export class GitWriteRpcs extends RpcGroup.make(
  GitInit,
  GitStage,
  GitUnstage,
  GitDiscard,
  GitCommit,
  GitSync
) {}
