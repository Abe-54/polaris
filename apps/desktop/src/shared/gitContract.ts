/**
 * The `git.*` IPC owned by the Explorer's Changes tab, spread into `RequestInputs`,
 * `SubscriptionInputs` and their outputs in `api.ts`.
 */
import {
  CommitMessageRequest,
  type CommitMessageStreamItem,
  type GitCommitItem,
  type GitInit,
  type GitLog,
  MAX_GIT_LOG,
  type GitStatus,
  GitSyncAction,
  type GitSyncItem,
} from "@polaris/protocol";
import { Schema } from "effect";
import type { Rpc } from "effect/rpc";

const HostKey = Schema.String.check(Schema.isMinLength(1));

/** Paths relative to the repository's top level, as `git.status` gave them. */
const Paths = { hostKey: HostKey, cwd: Schema.String, paths: Schema.Array(Schema.String) };

export const GitRequestInputs = {
  /** `ignored` also lists ignored paths, an ignored folder as one entry (the explorer greys them). */
  "git.status": Schema.Struct({
    hostKey: HostKey,
    cwd: Schema.String,
    ignored: Schema.optional(Schema.Boolean),
  }),
  /** Capability `git.init`: Open folder's new folder becomes a repository with a first commit. */
  "git.init": Schema.Struct({ hostKey: HostKey, path: Schema.String }),
  /** Capability `git.write`, like the two below. */
  "git.stage": Schema.Struct(Paths),
  "git.unstage": Schema.Struct(Paths),
  /** Tracked paths only; the Changes tab trashes an untracked file with `files.delete`. */
  "git.discard": Schema.Struct(Paths),
  /** Capability `git.log`: the newest commits from HEAD, for Settings' Commit messages preview. */
  "git.log": Schema.Struct({
    hostKey: HostKey,
    cwd: Schema.String,
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_GIT_LOG })),
  }),
};

export interface GitRequestOutputs {
  "git.status": Rpc.Success<typeof GitStatus>;
  "git.init": Rpc.Success<typeof GitInit>;
  "git.stage": null;
  "git.unstage": null;
  "git.discard": null;
  "git.log": Rpc.Success<typeof GitLog>;
}

export const GitSubscriptionInputs = {
  /** One commit: the hooks' output, then Committed or Failed. Closing it doesn't stop git. */
  "git.commit": Schema.Struct({ hostKey: HostKey, cwd: Schema.String, message: Schema.String }),
  /** A message for the staged changes (capability `commit.suggest-message`); closing it cancels. */
  "commit.suggestMessage": Schema.Struct({ hostKey: HostKey, ...CommitMessageRequest.fields }),
  /** An item each time the index, HEAD or refs move under `cwd` (capability `git.watch`). */
  "git.watch": Schema.Struct({ hostKey: HostKey, cwd: Schema.String }),
  /** Fetch, pull, push or publish (capability `git.sync`); closing it stops git. */
  "git.sync": Schema.Struct({ hostKey: HostKey, cwd: Schema.String, action: GitSyncAction }),
};

export interface GitSubscriptionItems {
  "git.commit": GitCommitItem;
  "commit.suggestMessage": CommitMessageStreamItem;
  "git.watch": null;
  "git.sync": GitSyncItem;
}
