/**
 * The contract every Harness driver implements. Polaris drives Harnesses and
 * never reimplements one: each driver adapts a vendor's structured interface
 * (Codex app-server, Claude Agent SDK) into these normalized events.
 *
 * The orchestration engine owns persistence and Session State; drivers only
 * translate. A driver never writes to the event store directly.
 */
import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalQuestion,
  Attachment,
  ContextCategory,
  ContextEntry,
  ContextSkills,
  HarnessKind,
  McpServerUsage,
  MessageUsage,
  MemoryFile,
  Model,
  ModelId,
  PermissionMode,
  ReasoningEffort,
  RequestId,
  SessionId,
  SlashCommand,
  SubagentId,
  BackgroundTask,
  TurnId,
  TurnItem,
  TurnTrigger,
} from "@polaris/protocol";
import type { ConstellationAttachment } from "./constellation/attachment.ts";
import { Data, type Effect, Schema, type Scope, type Stream } from "effect";

export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  harness: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** What fills the context window, as the Harness last counted it (see `ContextUsage`). */
export interface ContextBreakdown {
  readonly categories: ReadonlyArray<ContextCategory>;
  readonly memoryFiles: ReadonlyArray<MemoryFile>;
  /** The total the categories add up to when counted. */
  readonly countedTokens: number;
  readonly autoCompact: boolean | null;
  /** The rest of `ContextUsage`'s breakdown, when the Harness gives it. */
  readonly autoCompactAt?: number | null;
  readonly mcpServers?: ReadonlyArray<McpServerUsage>;
  readonly skills?: ContextSkills | null;
  readonly agents?: ReadonlyArray<ContextEntry>;
  readonly messages?: MessageUsage | null;
}

export type HarnessEvent = Data.TaggedEnum<{
  /** The Harness-native resume handle is known (or changed); persist it. */
  CursorAssigned: { readonly cursor: string };
  /**
   * A Turn began. `prompt` is the user's message when the driver knows it; the
   * engine records autonomous Turns and Turns from a co-attached or handed-off
   * terminal UI. Turns Polaris sent are already recorded.
   */
  TurnStarted: {
    readonly turnId: TurnId;
    readonly prompt: string | null;
    readonly trigger?: TurnTrigger;
  };
  /** Ephemeral streaming text for an item still in progress. */
  ItemDelta: {
    readonly turnId: TurnId;
    readonly itemId: string;
    readonly field: "text" | "output";
    readonly text: string;
    /** Set for a Subagent's own item; absent for the Turn's. The same holds on the item events below. */
    readonly subagentId?: SubagentId;
  };
  /**
   * The latest state of an item still in progress (a command that started, a plan
   * that changed). Ephemeral like `ItemDelta`: shown live, never persisted. The
   * same id is expected to end with an `ItemCompleted`; the engine drops progress
   * still open when its Turn ends.
   */
  ItemUpdated: {
    readonly turnId: TurnId;
    readonly item: TurnItem;
    readonly subagentId?: SubagentId;
  };
  /** The final state of an item; persisted. A later completion with the same id supersedes it. */
  ItemCompleted: {
    readonly turnId: TurnId;
    readonly item: TurnItem;
    readonly subagentId?: SubagentId;
  };
  /**
   * The Harness spawned a Subagent in `turnId`. Its own items then carry its
   * `subagentId`. It may outlive the Turn (a background agent).
   */
  BackgroundTasksChanged: { readonly tasks: ReadonlyArray<BackgroundTask> };
  SubagentStarted: {
    readonly turnId: TurnId;
    readonly subagentId: SubagentId;
    /** The Turn's item that spawned it (the Task tool call), when there is one. */
    readonly parentItemId: string | null;
    readonly title: string;
    readonly agent: string | null;
    readonly model: string | null;
    readonly background?: boolean;
  };
  SubagentEnded: {
    readonly subagentId: SubagentId;
    readonly status: "completed" | "failed" | "interrupted";
    readonly report?: string | null;
  };
  ApprovalRequested: {
    readonly turnId: TurnId;
    readonly requestId: RequestId;
    readonly kind: ApprovalKind;
    readonly title: string;
    readonly detail: string | null;
    readonly options: ReadonlyArray<string>;
    /** For questions: every question asked; absent or empty for one bare prompt. */
    readonly questions?: ReadonlyArray<ApprovalQuestion>;
  };
  /** The Harness withdrew or resolved a request itself (e.g. the Turn was interrupted). */
  ApprovalWithdrawn: { readonly requestId: RequestId };
  TurnEnded: {
    readonly turnId: TurnId;
    readonly status: "completed" | "interrupted" | "failed";
    readonly error: string | null;
    /** A failed Turn the Harness itself reported as stopped at a usage limit. */
    readonly limit?: { readonly resetsAt: string | null } | undefined;
  };
  TitleSuggested: { readonly title: string };
  /**
   * How full the context window is after the latest model call: the tokens it
   * carried, of the Model's window (null while the Harness hasn't said).
   */
  ContextUsed: {
    readonly usedTokens: number;
    readonly windowTokens: number | null;
    /** The Harness's latest breakdown of the window, when it gives one (Claude). */
    readonly breakdown?: ContextBreakdown | undefined;
    /** Set when this report follows a compaction of the window. */
    readonly compacted?:
      | undefined
      | {
          readonly trigger: "auto" | "manual" | null;
          readonly beforeTokens: number | null;
          readonly afterTokens: number | null;
        };
  };
  /** A Worktree the Harness created, so the engine can attribute it to this session. */
  WorktreeCreated: { readonly path: string };
  /** The Harness process went away. `error` is null for a clean shutdown. */
  Exited: { readonly error: string | null };
}>;

/** Constructors (`HarnessEvent.ItemDelta({ ... })`), `$is` and `$match` for `HarnessEvent`s. */
export const HarnessEvent = Data.taggedEnum<HarnessEvent>();

export interface OpenOptions {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly permissionMode: PermissionMode;
  /** The session's Model and effort; null for the Harness's and the Model's defaults. */
  readonly model: ModelId | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier?: "default" | "priority" | null;
  /** Resume an existing Harness-native session; null starts a fresh one. */
  readonly resumeCursor: string | null;
  /** A read-only session (the Reviewer): no network and no writes, where the Harness can enforce them. */
  readonly readOnly?: boolean;
  /** Trusted per-session tools and instructions, rebuilt when the Harness resumes. */
  readonly constellation?: ConstellationAttachment;
  readonly constellations?: ReadonlyArray<ConstellationAttachment>;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface TurnInput {
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<Attachment>;
  /**
   * The Model and effort the Turn records. They differ from `OpenOptions` after
   * `SetModel`; a driver whose Harness can switch applies them to this Turn.
   */
  readonly model: ModelId | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier?: "default" | "priority" | null;
  /** The user's shell command the Daemon ran for this Turn (`shellCommand` drivers); it stands for `prompt`. */
  readonly shellCommand?: ShellCommandRun;
}

/** A shell command the user ran (`RunShellCommand`), as the Harness should read it. */
export interface ShellCommandRun {
  readonly command: string;
  readonly stdout: string;
  readonly stderr: string;
  /** Null when it was stopped (a timeout) or never started. */
  readonly exitCode: number | null;
  /** Why it didn't run to its end ("timed out after 10 minutes"); null when it exited. */
  readonly failure: string | null;
}

export interface HarnessSession {
  /** Every event the Harness emits for this session, until it exits. Single consumer. */
  readonly events: Stream.Stream<HarnessEvent>;
  readonly sendTurn: (input: TurnInput) => Effect.Effect<void, HarnessError>;
  /** Atomically steer input and attachments into this live Turn; false if it ended. */
  readonly steerTurn?: (input: TurnInput) => Effect.Effect<boolean, HarnessError>;
  /**
   * Add guidance to the Turn in flight; fails if the Harness lacks `steer`. `attachments`
   * need `steerAttachments`; a driver without it never gets any.
   */
  readonly steer: (
    text: string,
    attachments?: ReadonlyArray<Attachment>
  ) => Effect.Effect<void, HarnessError>;
  readonly interrupt: Effect.Effect<void, HarnessError>;
  /** Stop these background tasks (ids from `BackgroundTasksChanged`); needs `stopBackground`. */
  readonly stopBackground?: (taskIds: ReadonlyArray<string>) => Effect.Effect<void, HarnessError>;
  /**
   * Move the running command `itemId` (every one when null) into the background; false
   * when none matched. Needs `backgroundCommand`.
   */
  readonly backgroundCommand?: (itemId: string | null) => Effect.Effect<boolean, HarnessError>;
  readonly respond: (
    requestId: RequestId,
    decision: ApprovalDecision
  ) => Effect.Effect<void, HarnessError>;
  readonly setPermissionMode: (mode: PermissionMode) => Effect.Effect<void, HarnessError>;
  /**
   * argv for "Open in terminal": the Harness's own TUI attached to this session.
   * Codex co-attaches live to the shared app-server; Claude hands off sequentially,
   * so the engine closes this session before launching it.
   */
  readonly terminalCommand: Effect.Effect<ReadonlyArray<string>, HarnessError>;
}

export interface HarnessProbe {
  readonly available: boolean;
  readonly version: string | null;
  readonly detail: string | null;
}

export interface HarnessDriver {
  readonly kind: HarnessKind;
  readonly capabilities: {
    readonly steer: boolean;
    /** A steer can carry attachments (`Steer.attachments`), images inline where the Harness reads them. */
    readonly steerAttachments?: boolean;
    /** Terminal UI can attach while Polaris stays attached (Codex). */
    readonly liveCoAttach: boolean;
    /** The Harness can change a session's Model between Turns (`SetModel`). */
    readonly switchModel: boolean;
    /** The Harness can stop its background tasks (`StopBackgroundTasks`). */
    readonly stopBackground?: boolean;
    /** The Harness can move a running command into the background (`BackgroundCommand`). */
    readonly backgroundCommand?: boolean;
    /** The Harness reads the user's shell commands (`RunShellCommand`, `TurnInput.shellCommand`). */
    readonly shellCommand?: boolean;
    /** A Turn whose prompt is `/compact` compacts the context window (`CompactSession`). */
    readonly compact?: boolean;
  };
  /**
   * For Harnesses that hand off sequentially (`liveCoAttach: false`): what the
   * Harness's own terminal UI does while the session is In Terminal, so Polaris
   * can follow along. The engine follows from the moment it has the terminal
   * command, and calls `release` on `ReturnFromTerminal`, which ends the stream
   * once it has drained. A `CursorAssigned` seen here is the cursor to resume
   * from afterwards (the terminal UI may have moved to a new native session).
   */
  readonly terminalFollow?: {
    readonly events: (sessionId: SessionId) => Stream.Stream<HarnessEvent>;
    readonly release: (sessionId: SessionId) => Effect.Effect<void>;
  };
  /** Must have no side effects: never open an authenticated session or start MCP servers. */
  readonly probe: Effect.Effect<HarnessProbe>;
  /** The Models the Harness offers on this Host, as it reports them; absent until the driver asks. */
  readonly listModels?: Effect.Effect<ReadonlyArray<Model>, HarnessError>;
  /** Validate the requested permission mode without sending a Turn or persisting a Harness session. */
  readonly validatePermissionMode?: (
    options: Pick<OpenOptions, "cwd" | "model" | "permissionMode">
  ) => Effect.Effect<void, HarnessError>;
  /**
   * The Skills and Slash Commands the Harness offers in `cwd`, read without side
   * effects; absent when it offers none Polaris can run.
   */
  readonly listCommands?: (cwd: string) => Effect.Effect<ReadonlyArray<SlashCommand>, HarnessError>;
  /** Starts or resumes a Harness session. Closing the scope stops it (the session goes Dormant). */
  readonly open: (options: OpenOptions) => Effect.Effect<HarnessSession, HarnessError, Scope.Scope>;
}
