/**
 * Contracts between the Daemon's modules. Each is implemented by one module
 * (named on the service) and consumed by others, so modules can be built and
 * tested independently. Change a contract here, in one place, when needed.
 */
import type {
  ApprovalDecision,
  ApprovalKind,
  Attachment,
  AttachmentId,
  BlobId,
  HarnessKind,
  PlanLimit,
  SessionId,
  TakeStreamOptions,
  TurnId,
  WorkspaceId,
} from "@polaris/protocol";
import { ReviewCheckoutBlocker } from "@polaris/protocol";
import { Context, type Effect, Schema, type Stream } from "effect";
import type {
  CheckoutInspection,
  Fetched,
  Interdiff,
  InterdiffInput,
  PullRequestFetch,
} from "./git/review/index.ts";
import type { HarnessDriver } from "./harness/HarnessDriver.ts";
import type { RulesOutcome, RulesRequest } from "./rules/run.ts";

export class ServiceError extends Schema.TaggedError<ServiceError>()("ServiceError", {
  service: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A Review Checkout step that can't go ahead, for a reason the user acts on. */
export class CheckoutBlocked extends Schema.TaggedError<CheckoutBlocked>()("CheckoutBlocked", {
  blocker: ReviewCheckoutBlocker,
}) {}

/**
 * Binary side-chunks beside the JSON frames, for one Client connection.
 * Implemented by `transport/`.
 */
export class BlobChannel extends Context.Service<
  BlobChannel,
  {
    /** Register bytes to send to the Client; returns the id to put in the RPC response. */
    readonly offer: (
      bytes: Uint8Array | Stream.Stream<Uint8Array, ServiceError>
    ) => Effect.Effect<BlobId>;
    /** Collect a blob the Client sent (or is sending) under `blobId`. */
    readonly take: (blobId: BlobId) => Effect.Effect<Uint8Array, ServiceError>;
    /**
     * The same blob chunk by chunk as it arrives, never held whole (uploads
     * written straight to disk). A blob is taken once, either way.
     */
    readonly takeStream: (
      blobId: BlobId,
      options?: TakeStreamOptions
    ) => Stream.Stream<Uint8Array, ServiceError>;
  }
>()("polaris/daemon/BlobChannel") {}

/**
 * The Rules layer of a Risk Summary: secrets (Betterleaks) and code patterns
 * (ast-grep) on the lines a change adds. Implemented by `rules/`.
 */
export class Rules extends Context.Service<
  Rules,
  {
    readonly run: (request: RulesRequest) => Effect.Effect<RulesOutcome, ServiceError>;
  }
>()("polaris/daemon/Rules") {}

/** Per-Turn git-ref checkpoints. Implemented by `git/`. */
export class Checkpoints extends Context.Service<
  Checkpoints,
  {
    /**
     * Snapshot the working tree of `cwd` (tracked and untracked, respecting .gitignore)
     * into `refs/polaris/checkpoints/<session>/<turn>/<label>` without touching the
     * user's index, HEAD or branch. Returns null when `cwd` is not in a git repo.
     */
    readonly capture: (options: {
      readonly cwd: string;
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly label: "before" | "after";
    }) => Effect.Effect<{ readonly ref: string; readonly commit: string } | null, ServiceError>;
  }
>()("polaris/daemon/Checkpoints") {}

export interface WorktreeInfo {
  readonly path: string;
  readonly branch: string | null;
  readonly head: string;
  readonly isMain: boolean;
  /** Set when the worktree is locked: the lock's reason, or "" without one. */
  readonly lockReason?: string;
}

/** Tracks every git worktree of a Workspace, wherever it lives. Implemented by `git/`. */
export class WorktreeTracker extends Context.Service<
  WorktreeTracker,
  {
    readonly list: (repoPath: string) => Effect.Effect<ReadonlyArray<WorktreeInfo>, ServiceError>;
    /** Emits the full list whenever it changes (git's registry is the source of truth). */
    readonly watch: (repoPath: string) => Stream.Stream<ReadonlyArray<WorktreeInfo>, ServiceError>;
    readonly create: (options: {
      readonly repoPath: string;
      readonly path: string;
      readonly branch: string;
      readonly baseRef: string | null;
    }) => Effect.Effect<WorktreeInfo, ServiceError>;
    /** Removes the worktree; keeps its branch unless `deleteBranchIfMerged` and it is merged. */
    readonly remove: (options: {
      readonly repoPath: string;
      readonly path: string;
      readonly deleteBranchIfMerged: boolean;
    }) => Effect.Effect<void, ServiceError>;
  }
>()("polaris/daemon/WorktreeTracker") {}

/**
 * Whether the user trusts a Workspace on this Host: the Trust worktree setup asks
 * for. Any doubt is false. Implemented by `transport/workspaceTrust.ts`.
 */
export class WorkspaceTrust extends Context.Service<
  WorkspaceTrust,
  { readonly trusted: (workspaceId: WorkspaceId) => Effect.Effect<boolean> }
>()("polaris/daemon/WorkspaceTrust") {}

/**
 * The git side of Review Checkouts, with hooks off throughout. Implemented by
 * `git/review/` (`git/ReviewCheckoutGit.ts`); the engine's `ReviewCheckouts` drives it.
 */
export class ReviewCheckoutGit extends Context.Service<
  ReviewCheckoutGit,
  {
    /** Fetch a PR's head and base into its review refs. */
    readonly fetchPullRequest: (
      options: PullRequestFetch
    ) => Effect.Effect<Fetched, CheckoutBlocked | ServiceError>;
    /** Pin an Agent Session's checkpoint commits under its review refs. */
    readonly pinCommits: (options: {
      readonly repoPath: string;
      readonly key: string;
      readonly head: string;
      readonly base: string;
    }) => Effect.Effect<Fetched, CheckoutBlocked | ServiceError>;
    /** The detached, locked worktree at `path` on `head` (kept as is when already there). */
    readonly ensure: (options: {
      readonly repoPath: string;
      readonly path: string;
      readonly head: string;
      readonly lockReason: string;
    }) => Effect.Effect<void, ServiceError>;
    /** `head`: the commit Polaris checked out there (its history is never the user's). */
    readonly inspect: (
      path: string,
      head: string | null
    ) => Effect.Effect<CheckoutInspection, ServiceError>;
    /** Move to `head`; `discardChanges` resets and cleans first (ignored files stay). */
    readonly move: (options: {
      readonly path: string;
      readonly head: string;
      readonly discardChanges: boolean;
    }) => Effect.Effect<void, ServiceError>;
    /** Remove the worktree (never forced) and its review refs; null `repoPath`: find it from `path`. */
    readonly remove: (options: {
      readonly repoPath: string | null;
      readonly path: string;
      readonly key: string;
    }) => Effect.Effect<void, ServiceError>;
    readonly markReviewed: (options: {
      readonly repoPath: string;
      readonly key: string;
      readonly head: string;
      readonly mergeBase: string;
    }) => Effect.Effect<void, ServiceError>;
    readonly interdiff: (input: InterdiffInput) => Effect.Effect<Interdiff, ServiceError>;
  }
>()("polaris/daemon/ReviewCheckoutGit") {}

/** Staged attachments under `~/.polaris/staging/<session>/`. Implemented by `attachments/`. */
export class AttachmentStore extends Context.Service<
  AttachmentStore,
  {
    readonly stage: (options: {
      readonly sessionId: SessionId | null;
      readonly workspaceId: WorkspaceId;
      readonly name: string;
      readonly mimeType: string;
      /** The content, whole or as a stream (written to disk as it arrives). */
      readonly bytes: Uint8Array | Stream.Stream<Uint8Array, ServiceError>;
    }) => Effect.Effect<Attachment, ServiceError>;
    readonly get: (
      ids: ReadonlyArray<AttachmentId>
    ) => Effect.Effect<ReadonlyArray<Attachment>, ServiceError>;
    /** Apply the cleanup policy for a session that was Archived. */
    readonly onSessionArchived: (sessionId: SessionId) => Effect.Effect<void, ServiceError>;
    /** Delete a removed Workspace's staged attachments and its cleanup override. */
    readonly onWorkspaceRemoved: (workspaceId: WorkspaceId) => Effect.Effect<void, ServiceError>;
  }
>()("polaris/daemon/AttachmentStore") {}

/** The installed Harness drivers. Each driver is implemented under `harness/<kind>/`. */
export class HarnessRegistry extends Context.Service<
  HarnessRegistry,
  {
    readonly get: (kind: HarnessKind) => Effect.Effect<HarnessDriver, ServiceError>;
    readonly all: Effect.Effect<ReadonlyArray<HarnessDriver>>;
  }
>()("polaris/daemon/HarnessRegistry") {}

/**
 * Where the Harness drivers report Plan Limits (ENG-206). `usage.watch` sends
 * each to every watcher, and the last value of each window survives restarts.
 * Implemented by `usage/`.
 */
export class PlanLimitSink extends Context.Service<
  PlanLimitSink,
  {
    /** The latest value of one Plan Limit window, keyed by (`harness`, `kind`, `scope`). */
    readonly report: (limit: PlanLimit) => Effect.Effect<void>;
  }
>()("polaris/daemon/PlanLimitSink") {}

/** An approval a Harness asked for, as an `ApprovalPolicy` sees it. */
export interface PolicyRequest {
  readonly sessionId: SessionId;
  readonly harness: HarnessKind;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string | null;
}

/**
 * Answers some sessions' approvals without asking the user (the Reviewer's
 * read-only session). The Supervisor consults it before an approval reaches
 * Needs You; null asks the user as usual. Implemented by `reviewer/`.
 */
export class ApprovalPolicy extends Context.Service<
  ApprovalPolicy,
  {
    readonly decide: (request: PolicyRequest) => Effect.Effect<ApprovalDecision | null>;
    /** The session is read-only: its Harness opens with no network or writes where it can enforce them. */
    readonly readOnly: (sessionId: SessionId) => boolean;
  }
>()("polaris/daemon/ApprovalPolicy") {}
