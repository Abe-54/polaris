/**
 * Portions adapted from pingdotgg/t3code@de251fc (MIT): resumable sequenced subscriptions.
 */
import { Effect, Schema } from "effect";

import { FileContent, FileEntry, FileError, EditorFileRpcs } from "./files.ts";

export { FileContent, FileEntry, FileError, FileKind } from "./files.ts";

import { ResourceRpcs } from "./resources.ts";
import { LanguageRpcs } from "./languages/rpc.ts";
import {
  ConstellationHostRpcs,
  ConstellationSummary,
  HostResource,
  ResourceLease,
} from "./constellation/index.ts";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  AcceptBranch,
  AcceptCommitted,
  AcceptDraft,
  AcceptPlan,
  AcceptPushed,
  AcceptRefused,
  CommitGranularity,
} from "./accept.ts";
import { AttachmentSettings, AttachmentUsage, StagedAmount } from "./attachments.ts";
import { AutoArchiveRpcs } from "./autoArchive.ts";
import { IdleCompactionRpcs } from "./idleCompaction.ts";
import { VisualsRpcs } from "./visuals.ts";
import { ContinuityRpcs } from "./continuity.ts";
import { PresenceRpcs } from "./presence.ts";
import { HostStatsRpcs } from "./hostStats.ts";
import { HostHarnesses } from "./availability.ts";
import { PredictionRpcs } from "./predictionRpcs.ts";
import { InlinePropose } from "./inline.ts";
import { CommitMessageRpcs } from "./commitMessage.ts";
import { Command } from "./commands.ts";
import {
  AgentSession,
  ApprovalRequest,
  Attachment,
  Subagent,
  Timestamp,
  TurnItem,
  Workspace,
  Worktree,
} from "./domain.ts";
import { EventEnvelope } from "./events.ts";
import { ExtensionRpcs, GrantGate, NotGranted } from "./extensions.ts";
import { RemoteAccessRpcs } from "./remoteAccess.ts";
import { LinkedDeviceRpcs } from "./linkedDevices.ts";
import { VoiceRpcs } from "./voice.ts";
import { SecretRpcs } from "./secrets.ts";
import { TerminalRpcs } from "./terminal.ts";
import { RestartRpcs } from "./restart.ts";
import { BrowserStackRpcs } from "./browser.ts";
import { HarnessKind } from "./harnesses.ts";
import { Hello } from "./hello.ts";
import {
  AttachmentId,
  BlobId,
  CommandId,
  ReviewCheckoutId,
  RiskFindingId,
  RiskSummaryId,
  Sequence,
  SessionId,
  SubagentId,
  TurnId,
  WorkspaceId,
} from "./ids.ts";
import { addedArray, addedNullable, Model, optionalArray, optionalNullable } from "./models.ts";
import {
  ReviewCheckout,
  ReviewCheckoutStatus,
  ReviewSubject,
  ResolvedReviewer,
  ReviewContext,
  ReviewerSettings,
  RiskSummary,
  RiskSummaryRef,
  Verdict,
} from "./review.ts";
import { HarnessCommands } from "./slashCommands.ts";
import { UsageReport, UsageStreamItem } from "./usage.ts";
import { NotFound, Unsupported } from "./errors.ts";
import { SessionTurnRpcs, TurnDetail } from "./turns.ts";
import { GitError, GitLogRpcs, GitTracking, GitWatchRpcs, GitWriteRpcs } from "./git.ts";

export { NotFound, Unsupported } from "./errors.ts";

export * from "./terminal.ts";

export { ReadTurns, SessionTurnRpcs, SubagentDetail, TurnDetail, TurnPage } from "./turns.ts";

// ── Errors ──────────────────────────────────────────────────────────────────

export class CommandRejected extends Schema.TaggedError<CommandRejected>()("CommandRejected", {
  commandId: CommandId,
  reason: Schema.String,
}) {}

/** The Harness can't answer on this Host: not installed, not signed in, or it failed. */
export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()(
  "HarnessUnavailable",
  { harness: HarnessKind, message: Schema.String }
) {}

// ── Handshake ───────────────────────────────────────────────────────────────

export { Hello, LanguageConnectionIdentity, LanguageIdentityError } from "./hello.ts";

// ── Commands ────────────────────────────────────────────────────────────────

export const Dispatch = Rpc.make("dispatch", {
  payload: { commandId: CommandId, command: Command },
  /** Sequence of the last event the command produced; a retried commandId returns the original. */
  success: Schema.Struct({ sequence: Schema.NullOr(Sequence) }),
  error: Schema.Union([CommandRejected, NotFound]),
});

// ── Streams ─────────────────────────────────────────────────────────────────

export class SessionSummary extends Schema.Class<SessionSummary>("SessionSummary")({
  session: AgentSession,
  pendingApprovals: Schema.Array(ApprovalRequest),
  lastTurnPreview: Schema.NullOr(Schema.String),
  /** Subagents still working, for Clients that announced `session.subagents`. */
  subagents: addedArray(Subagent),
}) {}

export const HostStreamItem = Schema.TaggedUnion({
  Snapshot: {
    sequence: Sequence,
    workspaces: Schema.Array(Workspace),
    worktrees: Schema.Array(Worktree),
    sessions: Schema.Array(SessionSummary),
    /** Open Review Checkouts, for Clients that announced `review.checkouts`. */
    reviewCheckouts: optionalArray(ReviewCheckout),
    /** The Host's Constellations as a listing; each one's contents come from its own stream. */
    constellations: Schema.optionalKey(Schema.Array(ConstellationSummary)),
    resources: Schema.optionalKey(Schema.Array(HostResource)),
    resourceLeases: Schema.optionalKey(Schema.Array(ResourceLease)),
  },
  Event: { envelope: EventEnvelope },
  /** Everything up to now has been sent; later items are live. */
  Synchronized: { sequence: Sequence },
});

export type HostStreamItem = typeof HostStreamItem.Type;

export const SubscribeHost = Rpc.make("subscribeHost", {
  payload: { afterSequence: Schema.NullOr(Sequence) },
  success: HostStreamItem,
  stream: true,
});

export const SessionStreamItem = Schema.TaggedUnion({
  Snapshot: {
    sequence: Sequence,
    session: AgentSession,
    turns: Schema.Array(TurnDetail),
    pendingApprovals: Schema.Array(ApprovalRequest),
  },
  Event: { envelope: EventEnvelope },
  /** Ephemeral live output for an item still in progress. Not persisted, not sequenced. */
  Delta: {
    turnId: TurnId,
    itemId: Schema.String,
    field: Schema.Literals(["text", "output"]),
    text: Schema.String,
    /** Set for a Subagent's own item (sent only to Clients with `session.subagents`). */
    subagentId: addedNullable(SubagentId),
  },
  /**
   * The latest state of an item still in progress (a running command, a plan being
   * worked through), replacing any earlier progress for the same `item.id`. Like
   * `Delta`: live-only, not persisted, not sequenced; the item's final state
   * arrives as a `TurnItemCompleted` event. Sent only to Clients that announced
   * the `session.live-items` capability. Right after `Synchronized`, the Daemon
   * sends the progress of every item still running, so a Client that subscribes
   * mid-Turn sees them too.
   */
  ItemProgress: { turnId: TurnId, item: TurnItem, subagentId: addedNullable(SubagentId) },
  Synchronized: { sequence: Sequence },
});

export type SessionStreamItem = typeof SessionStreamItem.Type;

export const SubscribeSession = Rpc.make("subscribeSession", {
  payload: {
    sessionId: SessionId,
    afterSequence: Schema.NullOr(Sequence),
    /** Only send the most recent N Turns in the snapshot. */
    turnLimit: Schema.NullOr(Schema.Int),
  },
  success: SessionStreamItem,
  error: NotFound,
  stream: true,
});

/** How to launch a Harness's own terminal UI for a session that is In Terminal. */
export class TerminalLaunch extends Schema.Class<TerminalLaunch>("TerminalLaunch")({
  /** Pass to `terminal.open` as `argv`. */
  argv: Schema.Array(Schema.String),
  /** The session's working directory; pass to `terminal.open` as `cwd`. */
  cwd: Schema.String,
  /** Variables to set on top of the login environment; often empty. */
  env: Schema.Record(Schema.String, Schema.String),
}) {}

/**
 * The terminal UI command for "Open in terminal". Null until the session is
 * In Terminal and the Harness has produced its command (shortly after the
 * `OpenInTerminal` ack), and again after `ReturnFromTerminal`.
 */
export const SessionTerminalCommand = Rpc.make("session.terminalCommand", {
  payload: { sessionId: SessionId },
  success: Schema.NullOr(TerminalLaunch),
  error: NotFound,
});

// ── Harnesses ───────────────────────────────────────────────────────────────

export class HarnessModels extends Schema.Class<HarnessModels>("HarnessModels")({
  harness: HarnessKind,
  /** As the Harness reports them, in its order. */
  models: Schema.Array(Model),
  /**
   * The Harness can change an Agent Session's Model between Turns (`SetModel`).
   * Otherwise a Client offers a Fork with the new Model instead.
   */
  switchesModel: Schema.Boolean,
  /** The Harness can move a running command into the background (`BackgroundCommand`). */
  backgroundsCommands: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** The Harness takes attachments in a steer (`Steer.attachments`); false from older Daemons. */
  steersAttachments: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false))
  ),
  /** The Harness takes the user's shell commands (`RunShellCommand`); false from older Daemons. */
  runsShellCommands: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false))
  ),
  /** When the Daemon last asked the Harness; the list is cached per Host. */
  fetchedAt: Timestamp,
}) {}

/**
 * A Harness's Models on this Host (capability `harness.models`). `refresh`
 * asks the Harness again instead of answering from the Daemon's cache.
 */
export const ListModels = Rpc.make("harness.models", {
  payload: { harness: HarnessKind, refresh: Schema.Boolean },
  success: HarnessModels,
  error: Schema.Union([NotFound, Unsupported, HarnessUnavailable]),
});

export const SpinnerVerbsMode = Schema.Literals(["replace", "append"]);

/** Claude Code's `spinnerVerbs` setting, as the settings file that wins defines it. */
export class SpinnerVerbs extends Schema.Class<SpinnerVerbs>("SpinnerVerbs")({
  /** `replace`: only these; `append`: after the built-in ones. */
  mode: SpinnerVerbsMode,
  verbs: Schema.Array(Schema.String),
  /** The settings file it came from, as the Host spells it. */
  source: Schema.String,
}) {}

/**
 * Claude Code's spinner verbs on this Host (capability `harness.spinner-verbs`): `spinnerVerbs`
 * from `~/.claude/settings.json`, overridden by `<cwd>/.claude/settings.json`, then
 * `<cwd>/.claude/settings.local.json`; null when none sets it. Read-only, re-read when a file changes.
 */
export const ClaudeSpinnerVerbs = Rpc.make("harness.spinnerVerbs", {
  payload: { cwd: Schema.NullOr(Schema.String) },
  success: Schema.NullOr(SpinnerVerbs),
});

/**
 * A Harness's Skills and Slash Commands for a directory (capability
 * `harness.commands`), read without side effects and cached per Harness and
 * directory; `refresh` reads them again. Unknown or unlisted: an empty list.
 */
export const ListHarnessCommands = Rpc.make("harness.commands", {
  payload: { harness: HarnessKind, cwd: Schema.String, refresh: Schema.Boolean },
  success: HarnessCommands,
  error: Schema.Union([NotFound, Unsupported, HarnessUnavailable]),
});

/**
 * Every Harness's availability on this Host (capability `harness.availability`).
 * Answered from the Daemon's cache; `refresh` probes again. Probing runs each
 * Harness's version and sign-in status commands, which have no side effects.
 */
export const HarnessAvailabilityQuery = Rpc.make("harness.availability", {
  payload: { refresh: Schema.Boolean },
  success: HostHarnesses,
  error: Unsupported,
});

/**
 * Availability as it changes (capability `harness.availability`): the current
 * report first, then one per probe. The Daemon never probes on a timer; ask
 * `harness.availability` with `refresh`, e.g. once a sign-in terminal exits.
 */
export const WatchHarnessAvailability = Rpc.make("harness.watchAvailability", {
  payload: {},
  success: HostHarnesses,
  error: Unsupported,
  stream: true,
});

// ── Usage ───────────────────────────────────────────────────────────────────

/**
 * Hourly Usage buckets that overlap `[from, to)` (capability `usage`),
 * optionally for one Harness or one Agent Session. Starts an index pass and
 * answers within ~250 ms from what is indexed; `indexing` says whether the
 * pass (e.g. the first over large logs) is still running.
 */
export const QueryUsage = Rpc.make("usage.query", {
  payload: {
    from: Timestamp,
    to: Timestamp,
    harness: Schema.NullOr(HarnessKind),
    sessionId: Schema.NullOr(SessionId),
  },
  success: UsageReport,
  error: Unsupported,
});

/**
 * Usage and Plan Limit changes as they happen (capability `usage`): every
 * known Plan Limit first, then changes. It doesn't index by itself: Usage
 * changes flow once a Client has queried (`usage.query`). A new item kind
 * needs its own capability, sent only to Clients that announce it, as
 * `ItemProgress` does.
 */
export const WatchUsage = Rpc.make("usage.watch", {
  payload: {},
  success: UsageStreamItem,
  error: Unsupported,
  stream: true,
});

// ── Files (read-mostly in M1) ───────────────────────────────────────────────

export const ListDir = Rpc.make("files.listDir", {
  payload: { path: Schema.String },
  success: Schema.Array(FileEntry),
  error: FileError,
});

export const Stat = Rpc.make("files.stat", {
  payload: { path: Schema.String },
  success: FileEntry,
  error: FileError,
});

/**
 * Small reads return inline text; larger or binary reads return a BlobId whose
 * bytes follow as binary side-chunks.
 */
export const ReadFile = Rpc.make("files.read", {
  payload: {
    path: Schema.String,
    offset: Schema.NullOr(Schema.Int),
    length: Schema.NullOr(Schema.Int),
  },
  success: Schema.Struct({
    size: Schema.Int,
    mimeType: Schema.String,
    content: FileContent,
  }),
  error: FileError,
});

export const SearchPaths = Rpc.make("files.searchPaths", {
  payload: { root: Schema.String, query: Schema.String, limit: Schema.Int },
  success: Schema.Array(Schema.Struct({ path: Schema.String, score: Schema.Number })),
  error: FileError,
});

export const Grep = Rpc.make("files.grep", {
  payload: {
    root: Schema.String,
    pattern: Schema.String,
    regex: Schema.Boolean,
    caseSensitive: Schema.Boolean,
    limit: Schema.Int,
  },
  success: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      line: Schema.Int,
      column: Schema.Int,
      text: Schema.String,
    })
  ),
  error: FileError,
});

export const FileChangeEvent = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["created", "modified", "deleted", "renamed"]),
});

export const WatchFiles = Rpc.make("files.watch", {
  payload: { root: Schema.String },
  success: Schema.Array(FileChangeEvent),
  error: FileError,
  stream: true,
});

// ── Git ─────────────────────────────────────────────────────────────────────

export class GitStatusEntry extends Schema.Class<GitStatusEntry>("GitStatusEntry")({
  path: Schema.String,
  origPath: Schema.NullOr(Schema.String),
  index: Schema.String,
  worktree: Schema.String,
}) {}

export const GitStatus = Rpc.make("git.status", {
  payload: {
    cwd: Schema.String,
    /** Also list ignored paths (`!`), a folder as one entry. Older Daemons drop the field. */
    ignored: Schema.optional(Schema.Boolean),
  },
  success: Schema.Struct({
    branch: Schema.NullOr(Schema.String),
    head: Schema.NullOr(Schema.String),
    ahead: Schema.Int,
    behind: Schema.Int,
    entries: Schema.Array(GitStatusEntry),
    /** Capability `git.sync`: the upstream, and where Publish branch would push. */
    tracking: Schema.optional(GitTracking),
  }),
  error: GitError,
});

/** What `git.diff` compares. */
export const GitDiffSpec = Schema.TaggedUnion({
  WorkingTree: { base: Schema.NullOr(Schema.String) },
  Turn: { sessionId: SessionId, turnId: TurnId },
  Range: { base: Schema.String, head: Schema.String },
  /**
   * A contiguous run of an Agent Session's Turns (capability `git.diff-turns`):
   * the first one's before-checkpoint to the last one's after-checkpoint.
   */
  Turns: { sessionId: SessionId, firstTurnId: TurnId, lastTurnId: TurnId },
});

export type GitDiffSpec = typeof GitDiffSpec.Type;

export const DiffFileStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "mode-changed",
]);

export type DiffFileStatus = typeof DiffFileStatus.Type;

/** One file of a `git.diff` patch: where its bytes are, so a Client can parse files in batches. */
export class DiffFile extends Schema.Class<DiffFile>("DiffFile")({
  /** The new path (the old one for a deletion). */
  path: Schema.String,
  /** Set for renames and copies. */
  oldPath: Schema.NullOr(Schema.String),
  status: DiffFileStatus,
  /** Byte offset of its `diff --git` line in the patch, and its length in bytes. */
  offset: Schema.Int,
  length: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int,
  binary: Schema.Boolean,
  generated: optionalNullable(Schema.Boolean), // Generated or lockfile; null: older Daemon.
}) {}

/** A unified diff; delivered as a blob because diffs can be very large. */
export const GitDiff = Rpc.make("git.diff", {
  payload: {
    cwd: Schema.String,
    spec: GitDiffSpec,
  },
  success: Schema.Struct({
    blobId: BlobId,
    size: Schema.Int,
    files: Schema.Int,
    /** Each file in patch order (capability `git.diff-files`; empty from older Daemons). */
    fileIndex: optionalArray(DiffFile),
  }),
  error: Schema.Union([GitError, NotFound]),
});

/**
 * A file's content at a revision (capability `git.show`; an empty `revision` is the index), for
 * diff context. Like `files.read`: inline text, or a blob when large or binary.
 */
export const GitShow = Rpc.make("git.show", {
  payload: { cwd: Schema.String, revision: Schema.String, path: Schema.String },
  success: Schema.Struct({ size: Schema.Int, mimeType: Schema.String, content: FileContent }),
  error: Schema.Union([GitError, NotFound]),
});

// ── Review (README, "Review") ───────────────────────────────────────────────

/**
 * What a Review Checkout looks like on disk now (capability `review.checkouts`):
 * local edits, commits and what runs inside, which block an update or removal.
 */
export const ReviewCheckoutStatusQuery = Rpc.make("review.checkoutStatus", {
  payload: { checkoutId: ReviewCheckoutId },
  success: ReviewCheckoutStatus,
  error: Schema.Union([NotFound, GitError, Unsupported]),
});

/**
 * Start a Risk Summary, or answer the cached one for the same key
 * (capability `review.risk-summary`). `since` asks for only the changes
 * after that head; `refresh` runs again even when one is cached.
 */
export const RunRiskSummary = Rpc.make("review.runRiskSummary", {
  payload: {
    workspaceId: WorkspaceId,
    subject: ReviewSubject,
    checkoutId: Schema.NullOr(ReviewCheckoutId),
    since: Schema.NullOr(Schema.String),
    refresh: Schema.Boolean,
    /** A pull request's title and description, for the Reviewer; absent decodes as null. */
    context: addedNullable(ReviewContext),
  },
  success: RiskSummary,
  error: Schema.Union([NotFound, GitError, Unsupported]),
});

/** Explicitly write/retry or stop the walkthrough on this head; ready output remains cached. */
export const RunWalkthrough = Rpc.make("review.runWalkthrough", {
  payload: { summaryId: RiskSummaryId, context: addedNullable(ReviewContext) },
  success: RiskSummary,
  error: Schema.Union([NotFound, GitError, Unsupported]),
});

export const StopWalkthrough = Rpc.make("review.stopWalkthrough", {
  payload: { summaryId: RiskSummaryId },
  success: Schema.Void,
  error: Schema.Union([NotFound, Unsupported]),
});

/** A Risk Summary by id, or the latest for a key; null when there is none. */
export const GetRiskSummary = Rpc.make("review.riskSummary", {
  payload: { ref: RiskSummaryRef },
  success: Schema.NullOr(RiskSummary),
  error: Unsupported,
});

/**
 * A Risk Summary as it fills in: the current one first, then the whole
 * summary again after each change (layers, Findings, Verdicts, its end).
 */
export const WatchRiskSummary = Rpc.make("review.watchRiskSummary", {
  payload: { summaryId: RiskSummaryId },
  success: RiskSummary,
  error: Schema.Union([NotFound, Unsupported]),
  stream: true,
});

/**
 * Ask the Reviewer about a Finding, or the whole change when `findingId` is
 * null (capability `review.ask`). It continues the Reviewer's own read-only
 * Agent Session, whose stream carries the answer; Findings it adds, revises
 * or withdraws arrive on the summary.
 */
export const AskFinding = Rpc.make("review.askFinding", {
  payload: {
    summaryId: RiskSummaryId,
    findingId: Schema.NullOr(RiskFindingId),
    question: Schema.String,
  },
  success: Schema.Struct({ sessionId: SessionId, turnId: TurnId }),
  error: Schema.Union([NotFound, Unsupported, HarnessUnavailable]),
});

/**
 * Verdicts recorded on this Host, newest first (capability `review.verdicts`):
 * one repo's, or one summary's; `identity` narrows to one Finding's history
 * ("You dismissed a similar finding here").
 */
export const ListVerdicts = Rpc.make("review.verdicts", {
  payload: {
    repo: Schema.NullOr(Schema.String),
    summaryId: Schema.NullOr(RiskSummaryId),
    identity: Schema.NullOr(Schema.String),
    limit: Schema.Int,
  },
  success: Schema.Array(Verdict),
  error: Unsupported,
});

// ── Accepting an Agent Session's work (README, "Review"; accept.ts) ─────────

const AcceptErrors = Schema.Union([NotFound, GitError, AcceptRefused, Unsupported]);

/**
 * Which Turns committing through `throughTurnId` takes, and the branch and remote it would use.
 * A null `throughTurnId` means the latest Turn (capability `session.accept-latest`).
 */
export const GetAcceptPlan = Rpc.make("session.acceptPlan", {
  payload: { sessionId: SessionId, throughTurnId: Schema.NullOr(TurnId) },
  success: AcceptPlan,
  error: AcceptErrors,
});

/**
 * The commit message and pull request text, drafted by the session's own
 * Harness in a short Turn kept out of the session; a template when it can't.
 */
export const DraftAccept = Rpc.make("session.draftAccept", {
  payload: { sessionId: SessionId, throughTurnId: TurnId },
  success: AcceptDraft,
  error: AcceptErrors,
});

/**
 * Commits the accepted, not yet committed Turns through `throughTurnId`: only
 * their own changes, leaving the working tree and later Turns as they are.
 */
export const CommitAccepted = Rpc.make("session.commitAccepted", {
  payload: {
    sessionId: SessionId,
    throughTurnId: TurnId,
    branch: AcceptBranch,
    granularity: CommitGranularity,
    title: Schema.String,
    body: Schema.String,
    /** One per Turn of the plan, for `per-turn`. */
    turnTitles: Schema.Array(Schema.String),
  },
  success: AcceptCommitted,
  error: AcceptErrors,
});

/** Pushes the branch with the Host's own git credentials, setting its upstream. */
export const PushAccepted = Rpc.make("session.pushAccepted", {
  payload: { sessionId: SessionId, branch: Schema.String },
  success: AcceptPushed,
  error: AcceptErrors,
});

/**
 * The Reviewer settings on this Host, and the Reviewer `workspaceId`'s Reviews
 * would run now (capability `review.reviewer-settings`).
 */
export const GetReviewerSettings = Rpc.make("review.reviewerSettings", {
  payload: { workspaceId: Schema.NullOr(WorkspaceId) },
  success: Schema.Struct({ settings: ReviewerSettings, resolved: ResolvedReviewer }),
  error: Unsupported,
});

/** Replaces the Reviewer settings; they apply from the next Risk Summary. */
export const SetReviewerSettings = Rpc.make("review.setReviewerSettings", {
  payload: { settings: ReviewerSettings },
  success: Schema.Void,
  error: Unsupported,
});

// ── Attachments ─────────────────────────────────────────────────────────────

/** The Client first sends the bytes as binary side-chunks under `blobId`. */
export const StageAttachment = Rpc.make("attachments.stage", {
  payload: {
    sessionId: Schema.NullOr(SessionId),
    workspaceId: WorkspaceId,
    name: Schema.String,
    mimeType: Schema.String,
    blobId: BlobId,
  },
  success: Attachment,
  error: FileError,
});

/** Above this an attachment isn't read for a preview: Clients show its name instead. */
export const ATTACHMENT_READ_MAX_BYTES = 10_485_760;

/**
 * A staged attachment's bytes by its id, never by path (capability `attachments.read`),
 * so a Linked Device shows the images a message carried. Its bytes follow as a blob.
 */
export const ReadAttachment = Rpc.make("attachments.read", {
  payload: { attachmentId: AttachmentId },
  success: Schema.Struct({ attachment: Attachment, blobId: BlobId }),
  error: FileError,
});

/** The Host's cleanup settings and what it has staged (capability `attachments.settings`). */
export const GetAttachmentSettings = Rpc.make("attachments.settings", {
  payload: {},
  success: Schema.Struct({ settings: AttachmentSettings, usage: AttachmentUsage }),
  error: Schema.Union([Unsupported, FileError]),
});

/** Replaces the cleanup settings; they apply from the next sweep or archive. */
export const SetAttachmentSettings = Rpc.make("attachments.setSettings", {
  payload: { settings: AttachmentSettings },
  error: Schema.Union([Unsupported, FileError]),
});

/** Deletes staged attachments now, all of them or one Workspace's; answers what it removed. */
export const ClearAttachments = Rpc.make("attachments.clear", {
  payload: { workspaceId: Schema.NullOr(WorkspaceId) },
  success: StagedAmount,
  error: Schema.Union([Unsupported, FileError]),
});

export class DaemonRpcs extends RpcGroup.make(
  InlinePropose,
  Hello,
  Dispatch,
  SubscribeHost,
  SubscribeSession,
  SessionTerminalCommand,
  ListModels,
  ListHarnessCommands,
  ClaudeSpinnerVerbs,
  HarnessAvailabilityQuery,
  WatchHarnessAvailability,
  QueryUsage,
  WatchUsage,
  ListDir,
  Stat,
  ReadFile,
  SearchPaths,
  Grep,
  WatchFiles,
  GitStatus,
  GitDiff,
  GitShow,
  ReviewCheckoutStatusQuery,
  RunRiskSummary,
  RunWalkthrough,
  StopWalkthrough,
  GetRiskSummary,
  WatchRiskSummary,
  AskFinding,
  ListVerdicts,
  GetAcceptPlan,
  DraftAccept,
  CommitAccepted,
  PushAccepted,
  GetReviewerSettings,
  SetReviewerSettings,
  StageAttachment,
  GetAttachmentSettings,
  SetAttachmentSettings,
  ClearAttachments,
  ReadAttachment
)
  .merge(ConstellationHostRpcs, ResourceRpcs, EditorFileRpcs)
  .merge(LanguageRpcs, PredictionRpcs, SessionTurnRpcs)
  .merge(AutoArchiveRpcs, IdleCompactionRpcs, ContinuityRpcs, PresenceRpcs, HostStatsRpcs)
  .merge(VisualsRpcs)
  .merge(GitWriteRpcs, GitWatchRpcs, GitLogRpcs, CommitMessageRpcs)
  .merge(ExtensionRpcs, RemoteAccessRpcs, LinkedDeviceRpcs, VoiceRpcs, RestartRpcs)
  .merge(SecretRpcs, TerminalRpcs)
  .merge(BrowserStackRpcs) {}

/**
 * `DaemonRpcs` as the Daemon serves it to Extensions: every RPC can fail with
 * `NotGranted` (grants.ts). The SDK's Client is built on this group so the
 * refusal decodes; the Desktop App, never refused, stays on `DaemonRpcs`.
 */
export class ExtensionDaemonRpcs extends DaemonRpcs.omit("dispatch")
  .add(Dispatch.setError(Schema.Union([CommandRejected, NotFound, NotGranted])))
  .middleware(GrantGate) {}
