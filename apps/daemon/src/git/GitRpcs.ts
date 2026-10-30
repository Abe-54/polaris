/**
 * Handlers for `git.*`: status, diff, show, log, and the Changes tab's writes. The
 * transport mounts this layer next to the other partial handler layers.
 */
import {
  DiffFile,
  GitCommit,
  GitCommitItem,
  GitDiff,
  GitDiscard,
  GitError,
  GitInit,
  GitLog,
  GitLogCommit,
  GitShow,
  GitStage,
  GitStatus,
  GitStatusEntry,
  GitSync,
  GitSyncItem,
  GitUnstage,
  GitWatch,
  NotFound,
} from "@polaris/protocol";
import { Cause, Effect, Match, Queue, Stream } from "effect";
import { RpcGroup } from "effect/rpc";
import { BlobChannel } from "../services.ts";
import { ReadContent, toContent } from "../files/fs.ts";
import { generatedPaths } from "../reviewer/generated.ts";
import { computeDiff, DiffNotFound, type DiffResult } from "./diff.ts";
import { indexDiff } from "./diffIndex.ts";
import { finishingGit, interruptibleGit, interruptibleGitPromise } from "./interrupt.ts";
import { gitLog } from "./log.ts";
import { showFile } from "./show.ts";
import { gitStatus, type Status } from "./status.ts";
import { publishRemoteAt, runSync, type SyncEvent } from "./sync.ts";
import { watchGit } from "./watch.ts";
import {
  commit,
  type CommitEvent,
  discardPaths,
  initRepository,
  stagePaths,
  unstagePaths,
} from "./write.ts";

export class GitRpcs extends RpcGroup.make(
  GitInit,
  GitStatus,
  GitDiff,
  GitShow,
  GitStage,
  GitUnstage,
  GitDiscard,
  GitCommit,
  GitWatch,
  GitSync,
  GitLog
) {}

const gitError = (cwd: string) => (cause: unknown) =>
  new GitError({ cwd, message: cause instanceof Error ? cause.message : String(cause) });

export const handleGitStatus = Effect.fn("git.status")(function* ({
  cwd,
  ignored,
}: typeof GitStatus.payloadSchema.Type) {
  const status = yield* interruptibleGit({
    try: () => gitStatus(cwd, { ignored: ignored === true }),
    catch: gitError(cwd),
  });

  const tracking = yield* interruptibleGitPromise(() => trackingOf(cwd, status));

  return {
    branch: status.branch,
    head: status.head,
    ahead: status.ahead,
    behind: status.behind,
    entries: status.entries.map((entry) => new GitStatusEntry(entry)),
    tracking,
  };
});

/** `tracking` (capability `git.sync`): asks git for the remotes only when there's no upstream to sync with. */
const trackingOf = async (cwd: string, status: Status) => ({
  upstream: status.upstream,
  gone: status.upstreamGone,
  remote:
    status.upstream === null || status.upstreamGone
      ? await publishRemoteAt(cwd).catch(() => null)
      : null,
});

/** The file index with each file's `generated` verdict; null where it couldn't be read. */
const indexWithGenerated = async (diff: DiffResult): Promise<ReadonlyArray<DiffFile>> => {
  const index = indexDiff(diff.bytes);

  const generated = await generatedPaths({
    root: diff.root,
    at: diff.rulesAt,
    repo: diff.root,
    paths: index.map((file) => file.path),
  }).catch(() => null);

  return index.map(
    (file) =>
      new DiffFile({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        offset: file.offset,
        length: file.length,
        additions: file.additions,
        deletions: file.deletions,
        binary: file.binary,
        generated: generated?.has(file.path) ?? null,
      })
  );
};

const notFoundOr = (cwd: string) => (cause: unknown) =>
  cause instanceof DiffNotFound
    ? new NotFound({ what: cause.what, id: cause.id })
    : gitError(cwd)(cause);

export const handleGitDiff = Effect.fn("git.diff")(function* ({
  cwd,
  spec,
}: typeof GitDiff.payloadSchema.Type) {
  const diff = yield* interruptibleGit({
    try: () => computeDiff(cwd, spec),
    catch: notFoundOr(cwd),
  });

  const fileIndex = yield* interruptibleGitPromise(() => indexWithGenerated(diff));
  const blobs = yield* BlobChannel;
  const blobId = yield* blobs.offer(diff.bytes);

  return { blobId, size: diff.bytes.byteLength, files: diff.files, fileIndex };
});

export const handleGitShow = Effect.fn("git.show")(function* ({
  cwd,
  revision,
  path,
}: typeof GitShow.payloadSchema.Type) {
  const file = yield* interruptibleGit({
    try: () => showFile(cwd, revision, path),
    catch: notFoundOr(cwd),
  });

  const content = toContent(file.mimeType, file.bytes);

  if (ReadContent.$is("Inline")(content)) {
    return { size: file.size, mimeType: file.mimeType, content };
  }

  const blobs = yield* BlobChannel;
  const blobId = yield* blobs.offer(file.bytes);

  return { size: file.size, mimeType: file.mimeType, content: { _tag: "Blob" as const, blobId } };
});

export const handleGitLog = Effect.fn("git.log")(function* ({
  cwd,
  limit,
}: typeof GitLog.payloadSchema.Type) {
  const commits = yield* interruptibleGit({ try: () => gitLog(cwd, limit), catch: gitError(cwd) });

  return { commits: commits.map((c) => new GitLogCommit(c)) };
});

const pathsWith =
  (name: string, write: (cwd: string, paths: ReadonlyArray<string>) => Promise<void>) =>
  ({ cwd, paths }: typeof GitStage.payloadSchema.Type) =>
    // Index and work tree writes: an interrupt lets them finish.
    finishingGit({ try: () => write(cwd, paths), catch: gitError(cwd) }).pipe(
      Effect.withSpan(name)
    );

export const handleGitInit = ({ path }: typeof GitInit.payloadSchema.Type) =>
  finishingGit({ try: () => initRepository(path), catch: gitError(path) }).pipe(
    Effect.withSpan("git.init")
  );

export const handleGitStage = pathsWith("git.stage", stagePaths);

export const handleGitUnstage = pathsWith("git.unstage", unstagePaths);

export const handleGitDiscard = pathsWith("git.discard", discardPaths);

const commitItem = (event: CommitEvent): GitCommitItem => {
  if (event.kind === "output") return GitCommitItem.cases.Output.make({ text: event.text });

  if (event.kind === "committed") return GitCommitItem.cases.Committed.make({ head: event.head });

  return GitCommitItem.cases.Failed.make({ exitCode: event.exitCode });
};

/** The commit runs in a promise of its own, so closing the stream never stops git midway. */
export const handleGitCommit = ({ cwd, message }: typeof GitCommit.payloadSchema.Type) =>
  Stream.callback<GitCommitItem, GitError>((queue) =>
    Effect.sync(() => {
      commit(cwd, message, (event) => Queue.offerUnsafe(queue, commitItem(event))).then(
        () => Queue.endUnsafe(queue),
        (cause: unknown) => Queue.failCauseUnsafe(queue, Cause.fail(gitError(cwd)(cause)))
      );
    })
  );

const syncItem = (event: SyncEvent): GitSyncItem =>
  Match.value(event).pipe(
    Match.discriminatorsExhaustive("kind")({
      step: ({ step, remote }) => GitSyncItem.cases.Step.make({ step, remote }),
      done: () => GitSyncItem.cases.Done.make({}),
      failed: ({ reason, exitCode, output }) =>
        GitSyncItem.cases.Failed.make({ reason, exitCode, output }),
    })
  );

/** Closing the stream (Cancel, or the Client going away) kills the git step that's running. */
export const handleGitSync = ({ cwd, action }: typeof GitSync.payloadSchema.Type) =>
  Stream.callback<GitSyncItem, GitError>((queue) =>
    Effect.gen(function* () {
      const stop = new AbortController();

      yield* Effect.addFinalizer(() => Effect.sync(() => stop.abort()));
      runSync(cwd, action, (event) => Queue.offerUnsafe(queue, syncItem(event)), {
        signal: stop.signal,
      }).then(
        () => Queue.endUnsafe(queue),
        (cause: unknown) => Queue.failCauseUnsafe(queue, Cause.fail(gitError(cwd)(cause)))
      );
    })
  );

/**
 * Requires `BlobChannel` per request: when the transport provides it per
 * connection through an RpcMiddleware, the handler picks that one up.
 */
export const GitRpcsLive = GitRpcs.toLayer({
  "git.status": handleGitStatus,
  "git.diff": handleGitDiff,
  "git.show": handleGitShow,
  "git.init": handleGitInit,
  "git.stage": handleGitStage,
  "git.unstage": handleGitUnstage,
  "git.discard": handleGitDiscard,
  "git.commit": handleGitCommit,
  "git.watch": ({ cwd }) => watchGit(cwd),
  "git.sync": handleGitSync,
  "git.log": handleGitLog,
});
