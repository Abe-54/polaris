import {
  AutoArchiveRpcs,
  CommitMessageError,
  CommitMessageRpcs,
  ContinuityRpcs,
  EditorFileRpcs,
  GitError,
  GitLogRpcs,
  GitWatchRpcs,
  GitWriteRpcs,
  IdleCompactionRpcs,
  SuggestedReplyRpcs,
  NotFound,
  SessionTurnRpcs,
  TerminalRpcs,
  VisualsRpcs,
} from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { fileError, notYet, unsupported, unsupportedFeed } from "./shared.ts";

const gitUnavailable = (cwd: string) => new GitError({ cwd, message: notYet("git") });

const editorFileDefaults = EditorFileRpcs.toLayer({
  "files.readVersioned": ({ path }) => Effect.fail(fileError(path, "versioned files")),
  "files.write": ({ path }) => Effect.fail(fileError(path, "file writing")),
  "files.create": ({ path }) => Effect.fail(fileError(path, "file management")),
  "files.rename": ({ path }) => Effect.fail(fileError(path, "file management")),
  "files.delete": ({ path }) => Effect.fail(fileError(path, "file management")),
  "files.watchFile": ({ path }) => Stream.fail(fileError(path, "file watching")),
});

const gitWriteDefaults = GitWriteRpcs.toLayer({
  "git.stage": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),
  "git.unstage": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),
  "git.discard": ({ cwd }) => Effect.fail(gitUnavailable(cwd)),
  "git.init": ({ path }) => Effect.fail(gitUnavailable(path)),
  "git.commit": ({ cwd }) => Stream.fail(gitUnavailable(cwd)),
  "git.sync": ({ cwd }) => Stream.fail(gitUnavailable(cwd)),
});

const commitMessageDefaults = CommitMessageRpcs.toLayer({
  "commit.suggestMessage": () =>
    Stream.fail(
      new CommitMessageError({
        reason: "harness-failed",
        message: "This Daemon does not support commit.suggestMessage",
      })
    ),
});

const terminalDefaults = TerminalRpcs.toLayer({
  "terminal.open": ({ cwd }) => Effect.fail(fileError(cwd, "terminals")),
  "terminal.attach": ({ terminalId }) =>
    Stream.fail(new NotFound({ what: "terminal", id: terminalId })),
  "terminal.attachBinary": ({ terminalId }) =>
    Stream.fail(new NotFound({ what: "terminal", id: terminalId })),
  "terminal.input": ({ terminalId }) =>
    Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
  "terminal.resize": ({ terminalId }) =>
    Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
  "terminal.close": ({ terminalId }) =>
    Effect.fail(new NotFound({ what: "terminal", id: terminalId })),
});

const sessionSettingsDefaults = Layer.mergeAll(
  SessionTurnRpcs.toLayer({
    "session.turns": ({ sessionId }) =>
      Effect.fail(new NotFound({ what: "session", id: sessionId })),
  }),
  AutoArchiveRpcs.toLayer({
    "sessions.autoArchive": unsupported("sessions.auto-archive"),
    "sessions.setAutoArchive": unsupported("sessions.auto-archive"),
  }),
  IdleCompactionRpcs.toLayer({
    "sessions.idleCompaction": unsupported("sessions.idle-compaction"),
    "sessions.setIdleCompaction": unsupported("sessions.idle-compaction"),
  }),
  SuggestedReplyRpcs.toLayer({
    "sessions.suggestedReplies": unsupported("sessions.suggested-replies"),
    "sessions.setSuggestedReplies": unsupported("sessions.suggested-replies"),
  }),
  VisualsRpcs.toLayer({
    "sessions.visuals": unsupported("sessions.visuals"),
    "sessions.setVisuals": unsupported("sessions.visuals"),
  }),
  ContinuityRpcs.toLayer({
    "continuity.watch": unsupportedFeed("session.continuity"),
    "continuity.markRead": unsupported("session.continuity"),
    "continuity.saveDraft": unsupported("session.continuity"),
  })
);

/** Editor files, git writes and watches, commit messages, terminals and session settings. */
export const workspaceDefaults = Layer.mergeAll(
  editorFileDefaults,
  gitWriteDefaults,
  GitWatchRpcs.toLayer({ "git.watch": ({ cwd }) => Stream.fail(gitUnavailable(cwd)) }),
  GitLogRpcs.toLayer({ "git.log": ({ cwd }) => Effect.fail(gitUnavailable(cwd)) }),
  commitMessageDefaults,
  terminalDefaults,
  sessionSettingsDefaults
);
