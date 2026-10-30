/**
 * Domain model shared by the Daemon and every Client. Names follow CONTEXT.md.
 */
import { Effect, Schema } from "effect";
import { CelestialBody } from "./celestial.ts";
import { HarnessKind } from "./harnesses.ts";
import {
  AttachmentId,
  HostId,
  RequestId,
  SessionId,
  SubagentId,
  Timestamp,
  TurnId,
  WorkspaceId,
  WorktreeId,
} from "./ids.ts";
import {
  addedNullable,
  ServiceTier,
  ModelId,
  optionalNullable,
  optionalArray,
  ReasoningEffort,
} from "./models.ts";
import { WorktreeSetup, WorktreeSetupRun } from "./worktreeSetup.ts";
import { ConstellationId } from "./constellation/domain.ts";
import { FeedbackBatch, PullRequestRef } from "./review.ts";

export { Timestamp } from "./ids.ts";

export const SessionState = Schema.Literals([
  "starting",
  "working",
  "needs-you",
  "idle",
  "in-terminal",
  "dormant",
  "failed",
  /** At a usage limit (capability `session.limited`; older Clients see Failed). */
  "limited",
  "archived",
]);

export type SessionState = typeof SessionState.Type;

/** Client-side only: how one Client's link to one Host stands. Never sent by a Daemon. */
export const ConnectionState = Schema.Literals([
  "connected",
  "reconnecting",
  "needs-attention",
  "offline",
]);

export type ConnectionState = typeof ConnectionState.Type;

/** The platforms a Daemon runs on, as `HostInfo.platform` names them (no libc suffix). */
export const Platform = Schema.Literals([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
]);

export type Platform = typeof Platform.Type;

/**
 * The platforms every Client decodes. Clients before 0.2.0 reject any other
 * `HostInfo.platform`, so `hello` only names another to a Client announcing `host.any-platform`.
 */
export const LEGACY_PLATFORMS = ["darwin-arm64", "linux-x64", "linux-arm64"] as const;

/**
 * `HostInfo.platform` on the wire: any name, so this Client keeps working with
 * a Host on a platform newer than itself. Compare against `Platform`'s literals.
 */
export const HostPlatformName = Schema.String;

/** A Linux Host's C library; `HostInfo.platform` leaves it out. */
export const HostLibc = Schema.Literals(["glibc", "musl"]);

export type HostLibc = typeof HostLibc.Type;

/** `DaemonStop.reason` for an upgrade that stopped the Daemon and started the new version. */
export const DAEMON_STOP_UPGRADE = "upgrade";

/**
 * Why the previous Daemon stopped, when it stopped on purpose and this one replaced it.
 * Its running terminals ended; Agent Sessions recovered from the event log as after a
 * restart. Only Windows upgrades this way for now (ADR 0060).
 */
export class DaemonStop extends Schema.Class<DaemonStop>("DaemonStop")({
  /** `upgrade` today; any string on the wire, so a later reason doesn't break this Client. */
  reason: Schema.String,
  /** The version that stopped. */
  fromVersion: Schema.String,
  /** When the stop was requested. */
  at: Timestamp,
}) {}

export class HostInfo extends Schema.Class<HostInfo>("HostInfo")({
  hostId: HostId,
  hostname: Schema.String,
  platform: HostPlatformName,
  /** Linux only; absent from Daemons before 0.1.0-alpha.4 and on macOS. */
  libc: Schema.optionalKey(HostLibc),
  daemonVersion: Schema.String,
  homeDir: Schema.String,
  startedAt: Timestamp,
  /** Set when this Daemon replaced one that was stopped for an upgrade; absent otherwise and from older Daemons. */
  previousStop: Schema.optionalKey(DaemonStop),
}) {}

export class Workspace extends Schema.Class<Workspace>("Workspace")({
  id: WorkspaceId,
  path: Schema.String,
  name: Schema.String,
  isGitRepo: Schema.Boolean,
  /** Where Polaris creates its own Worktrees; default `<repo>.worktrees/<branch>`. */
  worktreeRoot: Schema.String,
  hidden: Schema.Boolean,
  worktreeSetup: optionalNullable(WorktreeSetup),
  registeredAt: Timestamp,
}) {}

export class Worktree extends Schema.Class<Worktree>("Worktree")({
  id: WorktreeId,
  workspaceId: WorkspaceId,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.String,
  /** The Agent Session that created it, when known; otherwise it sits under the Workspace. */
  createdBySessionId: Schema.NullOr(SessionId),
  isMain: Schema.Boolean,
}) {}

/**
 * One row of a context breakdown. `kind`: `used` fills the window, `free` is what is
 * left, `buffer` is the compaction reserve, `deferred` is listed but outside the window.
 */
export class ContextCategory extends Schema.Class<ContextCategory>("ContextCategory")({
  name: Schema.String,
  kind: Schema.Literals(["used", "free", "buffer", "deferred"]),
  tokens: Schema.Int,
}) {}

/** An instruction file in the context window: its path, where it comes from ("Project", "User"), its size. */
export class MemoryFile extends Schema.Class<MemoryFile>("MemoryFile")({
  path: Schema.String,
  source: Schema.String,
  tokens: Schema.Int,
}) {}

/** One MCP server's tools as the Harness counts them: loaded ones sit in the window, the rest wait. */
export class McpServerUsage extends Schema.Class<McpServerUsage>("McpServerUsage")({
  name: Schema.String,
  tools: Schema.Int,
  loadedTools: Schema.Int,
  /** Its loaded tools' tokens, in the window. */
  tokens: Schema.Int,
  /** Its other tools' tokens, outside the window until the model loads them. */
  deferredTokens: Schema.Int,
}) {}

/** A skill, custom agent or similar entry the Harness lists in the window, with its size. */
export class ContextEntry extends Schema.Class<ContextEntry>("ContextEntry")({
  name: Schema.String,
  /** Where it comes from, in the Harness's words ("userSettings", "plugin"). */
  source: Schema.String,
  tokens: Schema.Int,
}) {}

/** Skills in the window: how many, their tokens, and the largest few (`top`, capped). */
export class ContextSkills extends Schema.Class<ContextSkills>("ContextSkills")({
  total: Schema.Int,
  included: Schema.Int,
  tokens: Schema.Int,
  top: Schema.Array(ContextEntry),
}) {}

/** The conversation's tokens by what carried them. */
export class MessageUsage extends Schema.Class<MessageUsage>("MessageUsage")({
  toolCalls: Schema.Int,
  toolResults: Schema.Int,
  replies: Schema.Int,
  userMessages: Schema.Int,
  /** Attachments and reminders the Harness adds to messages. */
  attachments: Schema.Int,
  /** What the Harness couldn't attribute, or redirected context. */
  other: Schema.Int,
}) {}

/**
 * How full the Agent Session's context window is, as its Harness last reported
 * it: the tokens the latest model call carried, of the window its Model has.
 */
export class ContextUsage extends Schema.Class<ContextUsage>("ContextUsage")({
  usedTokens: Schema.Int,
  /** The Model's context window; null while the Harness hasn't said. */
  windowTokens: Schema.NullOr(Schema.Int),
  /** What fills the window, by category, as the Harness counts it; empty when it gives totals only. */
  categories: optionalArray(ContextCategory),
  /** Instruction files loaded into the window (CLAUDE.md, rules), when the Harness lists them. */
  memoryFiles: optionalArray(MemoryFile),
  /** The `usedTokens` the breakdown was counted at; the total can move on before the next count. */
  categoriesTotal: optionalNullable(Schema.Int),
  /** Whether the Harness compacts on its own as the window fills; null when it doesn't say. */
  autoCompact: optionalNullable(Schema.Boolean),
  /** The used tokens at which it compacts; null when it doesn't say. */
  autoCompactAt: optionalNullable(Schema.Int),
  /** MCP servers by their tools, largest first; the servers' instructions are a category. */
  mcpServers: optionalArray(McpServerUsage),
  skills: optionalNullable(ContextSkills),
  /** Custom agents (subagent definitions) listed in the window. */
  agents: optionalArray(ContextEntry),
  messages: optionalNullable(MessageUsage),
}) {}

/** How one Harness compaction went: the tokens the window held before and after. */
export class Compaction extends Schema.Class<Compaction>("Compaction")({
  /** The Turn it happened in, when one was in flight. */
  turnId: Schema.NullOr(TurnId),
  /** `auto` when the window filled, `manual` for `/compact`; null when the Harness doesn't say. */
  trigger: Schema.NullOr(Schema.Literals(["auto", "manual"])),
  beforeTokens: Schema.NullOr(Schema.Int),
  afterTokens: Schema.NullOr(Schema.Int),
  at: Timestamp,
}) {}

/**
 * How much the agent may do without asking. `plan` (capability `session.plan-mode`) reads and
 * plans, and asks before it edits anything; a Daemon without it is sent `supervised` instead.
 */
export const PermissionMode = Schema.Literals([
  "plan",
  "supervised",
  "auto-edits",
  "auto",
  "full-access",
]);

export type PermissionMode = typeof PermissionMode.Type;

export const BackgroundTaskKind = Schema.Literals(["subagent", "command"]);

export type BackgroundTaskKind = typeof BackgroundTaskKind.Type;

export const BackgroundTaskRef = Schema.Struct({ id: Schema.String, kind: BackgroundTaskKind });

export type BackgroundTaskRef = typeof BackgroundTaskRef.Type;

export class BackgroundTask extends Schema.Class<BackgroundTask>("BackgroundTask")({
  id: Schema.String,
  kind: BackgroundTaskKind,
  description: Schema.String,
}) {}

/**
 * The user Turn a session is on (capability `session.user-turns`): its latest Turn without a
 * `trigger`, or its first Turn when the Harness started that one. `number` is the session's
 * user-Turn count, as `Turn.userTurnNumber` numbers them.
 */
export const CurrentUserTurn = Schema.Struct({
  turnId: TurnId,
  number: Schema.Int,
  startedAt: Timestamp,
});

export type CurrentUserTurn = typeof CurrentUserTurn.Type;

/** Who started a session for the user: a Reviewer or a walkthrough (capability `session.pin`). */
export const SessionOrigin = Schema.Literals(["reviewer", "walkthrough"]);

export type SessionOrigin = typeof SessionOrigin.Type;

/**
 * Marks a Constellation worker's session: it is reached through its Constellation, so session
 * lists leave it out unless it needs you, and it pushes only Needs You (ENG-586).
 */
export const SessionWorker = Schema.Struct({ constellationId: ConstellationId });

export type SessionWorker = typeof SessionWorker.Type;

/** Whether a session is a Constellation worker's (`AgentSession.worker`). */
export const isWorkerSession = (session: { readonly worker?: SessionWorker | null }) =>
  session.worker != null;

export class AgentSession extends Schema.Class<AgentSession>("AgentSession")({
  id: SessionId,
  workspaceId: WorkspaceId,
  harness: HarnessKind,
  title: Schema.String,
  /** The directory the Harness works in: the Workspace itself or one of its Worktrees. */
  cwd: Schema.String,
  worktreeId: Schema.NullOr(WorktreeId),
  state: SessionState,
  /** Live non-ambient background tasks; Idle with a nonempty list is waiting on them. */
  backgroundTasks: optionalArray(BackgroundTask),
  permissionMode: PermissionMode,
  /** The Model the next Turn runs on; null for the Harness's default. Changed by `SetModel`. */
  model: Schema.NullOr(ModelId),
  /** The reasoning effort the next Turn runs with; null for the Model's default. */
  effort: addedNullable(ReasoningEffort),
  serviceTier: optionalNullable(ServiceTier),
  /** Its Celestial: a planet the Daemon picks at creation, fixed for the session's life. */
  celestial: optionalNullable(CelestialBody),
  /** Set when this session is a Fork. */
  parentSessionId: Schema.NullOr(SessionId),
  forkedFromTurnId: Schema.NullOr(TurnId),
  /** Opaque Harness-native resume handle (Claude session id, Codex thread id). */
  harnessCursor: Schema.NullOr(Schema.String),
  turnCount: Schema.Int,
  /** Null before the first Turn, and from Daemons without `session.user-turns`. */
  currentUserTurn: optionalNullable(CurrentUserTurn),
  /** The latest ended Turn's `replyPreview` (capability `session.user-turns`). */
  lastReplyPreview: optionalNullable(Schema.String),
  /** Null until the Harness reports it; some Harnesses never do. */
  contextUsage: addedNullable(ContextUsage),
  /** The Harness's latest compaction, when it reported one (capability `session.compaction`). */
  lastCompaction: optionalNullable(Compaction),
  worktreeSetup: optionalNullable(WorktreeSetupRun),
  lastError: Schema.NullOr(Schema.String),
  /** The index of the last Turn the user accepted (`AcceptTurns`); null before any. */
  acceptedThroughIndex: optionalNullable(Schema.Int),
  /** The pull request the accepted work was opened as (`LinkPullRequest`). */
  pullRequest: optionalNullable(PullRequestRef),
  /** Set by the Daemon for a Reviewer's or walkthrough's own session; absent for the user's. */
  origin: optionalNullable(SessionOrigin),
  /** Set by the Daemon on a Constellation worker's session (`SessionWorker`); null for the rest. */
  worker: optionalNullable(SessionWorker),
  /** When the user pinned it to the top of the list (`PinSession`); null when it isn't. */
  pinnedAt: optionalNullable(Timestamp),
  /** While Limited: when the usage limit resets; null when the Harness didn't say. */
  limitResetsAt: optionalNullable(Timestamp),
  /** Continue a Limited session on its own at the reset (`SetResumeAtReset`); off by default. */
  resumeAtReset: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false))
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export const TurnStatus = Schema.Literals(["working", "completed", "interrupted", "failed"]);

export type TurnStatus = typeof TurnStatus.Type;

export class Attachment extends Schema.Class<Attachment>("Attachment")({
  id: AttachmentId,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Int,
  /** Absolute path on the Host under `~/.polaris/staging/<session>/`. */
  hostPath: Schema.String,
  /** An image's pixel size, read from its header when staged; null otherwise or when unknown. */
  width: addedNullable(Schema.Int),
  height: addedNullable(Schema.Int),
}) {}

/** Why the Harness began a Turn without user input. */
export const TurnTrigger = Schema.TaggedUnion({
  BackgroundTasksReported: { tasks: Schema.Array(BackgroundTaskRef) },
});

export type TurnTrigger = typeof TurnTrigger.Type;

export class Turn extends Schema.Class<Turn>("Turn")({
  id: TurnId,
  sessionId: SessionId,
  index: Schema.Int,
  prompt: Schema.String,
  trigger: optionalNullable(TurnTrigger),
  /**
   * One-based number of the user Turn it belongs to (capability `session.user-turns`): a Turn
   * with a `trigger` keeps the number of the Turn before it, and a session's first Turn is 1.
   */
  userTurnNumber: optionalNullable(Schema.Int),
  /**
   * Its last reply as plain text, cut to about 200 characters (capability `session.user-turns`);
   * null without reply text. Set while the Turn works, final on `TurnEnded`.
   */
  replyPreview: optionalNullable(Schema.String),
  attachments: Schema.Array(Attachment),
  /** The Model and effort the Turn ran on, as the session had them; null for the defaults. */
  model: addedNullable(ModelId),
  effort: addedNullable(ReasoningEffort),
  serviceTier: optionalNullable(ServiceTier),
  status: TurnStatus,
  /** Set when the Turn was sent from Review feedback (`SendFeedback`); `prompt` is its rendering. */
  feedback: optionalNullable(FeedbackBatch),
  /**
   * Set when the Turn is the user's shell command (`RunShellCommand`, capability
   * `session.shell-command`); `prompt` reads `! <command>`.
   */
  shellCommand: optionalNullable(Schema.String),
  /**
   * True when the Daemon sent `/compact` because the session sat Idle (`CompactSession`,
   * capability `sessions.idle-compaction`): not the user's Turn, so it keeps the Turn number.
   */
  idleCompaction: optionalNullable(Schema.Boolean),
  /** `refs/polaris/checkpoints/<session>/<turn>` taken before and after the Turn. */
  checkpointBefore: Schema.NullOr(Schema.String),
  checkpointAfter: Schema.NullOr(Schema.String),
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}) {}

export const SubagentStatus = Schema.Literals(["working", "completed", "failed", "interrupted"]);

export type SubagentStatus = typeof SubagentStatus.Type;

/**
 * A helper a Harness spawns inside an Agent Session (CONTEXT.md: Subagent).
 * It belongs to the Turn that spawned it, has its own items, and may outlive
 * that Turn (Claude's background agents); it ends when the Harness says so, or
 * `interrupted` when the Harness goes away first.
 */
export class Subagent extends Schema.Class<Subagent>("Subagent")({
  id: SubagentId,
  sessionId: SessionId,
  turnId: TurnId,
  /** The parent Turn's item that spawned it (Claude's Task call), when there is one. */
  parentItemId: Schema.NullOr(Schema.String),
  /** Its job in a few words, as the Harness describes it. */
  title: Schema.String,
  /** The kind of helper as the Harness names it (`Explore`, a Codex agent's name), when known. */
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelId),
  /** True when this helper can keep working after its parent Turn ends. */
  background: optionalNullable(Schema.Boolean),
  /** Markdown report supplied by the Harness, distinct from interim assistant text. */
  report: optionalNullable(Schema.String),
  status: SubagentStatus,
  startedAt: Timestamp,
  endedAt: Schema.NullOr(Timestamp),
}) {}

/**
 * When the Harness started an item, as its driver first saw it; strictly increasing per
 * Agent Session. Null on older items, the Daemon's own, and drivers that don't stamp.
 */
const startedAt = optionalNullable(Timestamp);

/**
 * What a Tool Call does, as its driver classifies it; `mcp` exactly when it carries an
 * `McpTool`. Commands and edits are their own items, never a `ToolCall`.
 */
export const ToolKind = Schema.Literals([
  "read",
  "search",
  "fetch",
  "web-search",
  "skill",
  "mcp",
  "other",
]);

export type ToolKind = typeof ToolKind.Type;

/** An MCP server's tool, by the names the server and its tool go by in the Harness. */
export const McpTool = Schema.Struct({ server: Schema.String, tool: Schema.String });

export type McpTool = typeof McpTool.Type;

/** One normalized piece of Harness output within a Turn. `raw` keeps the native frame. */
export const TurnItem = Schema.TaggedUnion({
  AssistantMessage: { id: Schema.String, text: Schema.String, startedAt },
  /**
   * Guidance the user sent into the Turn in flight (a steer), once the model took it in;
   * `startedAt` is when it did, so it follows whatever held it back. `attachments` are
   * the files the steer carried (capability `session.steer-attachments`).
   */
  UserMessage: {
    id: Schema.String,
    text: Schema.String,
    startedAt,
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
  },
  Reasoning: {
    id: Schema.String,
    text: Schema.String,
    /** When the Harness began and finished thinking, as its driver saw it; null when unknown. */
    startedAt: addedNullable(Timestamp),
    endedAt: addedNullable(Timestamp),
  },
  CommandExecution: {
    id: Schema.String,
    startedAt,
    command: Schema.String,
    cwd: Schema.String,
    output: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
    status: Schema.Literals(["running", "completed", "failed", "declined"]),
    /** Set when it moved to the background: the background task it keeps running as. */
    backgroundTaskId: optionalNullable(Schema.String),
    /** `user`: the user's shell command, which the Daemon ran (`RunShellCommand`); null for the Harness's. */
    origin: optionalNullable(Schema.Literals(["user"])),
  },
  FileChange: {
    id: Schema.String,
    startedAt,
    changes: Schema.Array(
      Schema.Struct({ path: Schema.String, kind: Schema.Literals(["add", "modify", "delete"]) })
    ),
    status: Schema.Literals(["running", "completed", "failed", "declined"]),
  },
  ToolCall: {
    id: Schema.String,
    startedAt,
    name: Schema.String,
    /** Null on older items and drivers that don't classify. */
    kind: optionalNullable(ToolKind),
    mcp: optionalNullable(McpTool),
    /** A human title the Harness gave the call (ACP's `title`), when it gives one. */
    title: optionalNullable(Schema.String),
    input: Schema.Unknown,
    output: Schema.NullOr(Schema.Unknown),
    status: Schema.Literals(["running", "completed", "failed", "declined"]),
  },
  Plan: {
    id: Schema.String,
    startedAt,
    steps: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        status: Schema.Literals(["pending", "in-progress", "completed"]),
        /** What the step is doing now (Claude's `activeForm`), when it says more than `text`. */
        detail: addedNullable(Schema.String),
      })
    ),
    /** Why the plan is what it is (Codex's plan explanation), when the Harness gives one. */
    explanation: addedNullable(Schema.String),
  },
  Error: { id: Schema.String, message: Schema.String, startedAt },
});

export type TurnItem = typeof TurnItem.Type;

/**
 * `items` with `item` placed by when it started: an item already there keeps its place
 * and takes the new content, a stamped one goes before the first stamped item that
 * started later, and an unstamped one goes at the end (where it completed).
 */
export const placeItem = (items: ReadonlyArray<TurnItem>, item: TurnItem): Array<TurnItem> => {
  const at = items.findIndex((i) => i.id === item.id);

  if (at !== -1) return items.map((i, n) => (n === at ? item : i));
  const start = item.startedAt;

  const before =
    start === null ? -1 : items.findIndex((i) => i.startedAt !== null && i.startedAt > start);

  return before === -1
    ? [...items, item]
    : [...items.slice(0, before), item, ...items.slice(before)];
};

/** Items listed in completion order (as stored and sent), placed by when they started. */
export const inStartOrder = (items: ReadonlyArray<TurnItem>): Array<TurnItem> =>
  items.reduce<Array<TurnItem>>(placeItem, []);

/** `secret`: a Secret Request (ADR 0089), sent only to Clients with `approval.secret`. */
export const ApprovalKind = Schema.Literals([
  "command",
  "file-change",
  "tool",
  "question",
  "secret",
]);

export type ApprovalKind = typeof ApprovalKind.Type;

export class QuestionOption extends Schema.Class<QuestionOption>("QuestionOption")({
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
}) {}

/** One of the questions a Harness asks in a single request. */
export class ApprovalQuestion extends Schema.Class<ApprovalQuestion>("ApprovalQuestion")({
  /** A short tag ("Scope"); empty when the Harness gave none. */
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(QuestionOption),
  /** Several options may be chosen together. */
  multiSelect: Schema.Boolean,
}) {}

export class ApprovalRequest extends Schema.Class<ApprovalRequest>("ApprovalRequest")({
  id: RequestId,
  sessionId: SessionId,
  turnId: TurnId,
  kind: ApprovalKind,
  /** One-line summary for hover cards and notifications. */
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  /** For questions: the first question's choices, if any. */
  options: Schema.Array(Schema.String),
  /** For questions: every question asked, in order; empty from Daemons before ENG-450. */
  questions: optionalArray(ApprovalQuestion),
  /** For a Secret Request: the field's hint, such as "tskey-auth-…". */
  placeholder: optionalNullable(Schema.String),
  /** For a Secret Request: when it times out unanswered. */
  expiresAt: optionalNullable(Timestamp),
  openedAt: Timestamp,
}) {}

export const ApprovalDecision = Schema.TaggedUnion({
  Allow: { remember: Schema.Boolean },
  Deny: { reason: Schema.NullOr(Schema.String) },
  Answer: {
    /** The whole answer as text, for a Harness or Daemon that reads only this. */
    text: Schema.String,
    /** Per question, in order: the chosen labels, or the typed answer as one entry. */
    answers: Schema.optionalKey(Schema.Array(Schema.Array(Schema.String))),
  },
  /** A Secret Request's value reached the Host; the value itself is never recorded (ADR 0089). */
  Provided: {},
});

export type ApprovalDecision = typeof ApprovalDecision.Type;
