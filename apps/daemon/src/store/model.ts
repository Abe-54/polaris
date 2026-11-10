/**
 * The in-memory read model: the current state of every Workspace, Worktree
 * and Agent Session on this Host, as a pure fold over `EventEnvelope`s.
 *
 * The decider validates commands against it, the stream snapshots are built
 * from it, and the SQL projection tables persist it (see `projection.ts`).
 * Turn items are the exception: they only live in SQL, and so do all but
 * the most recent `RECENT_TURNS` Turns of each session, so a long history
 * does not stay resident. Older Turns are finished and never change; read
 * them with `EventStore.readTurns`.
 */
import {
  AgentSession,
  type ConstellationId,
  type ApprovalRequest,
  DomainEvent,
  type EventEnvelope,
  type RequestId,
  type ReviewCheckout,
  type ReviewCheckoutId,
  type SessionId,
  type Subagent,
  type SubagentId,
  Turn,
  type TurnId,
  type Workspace,
  type WorkspaceId,
  type Worktree,
  type WorktreeId,
} from "@polaris/protocol";

import { emptyResources, foldResources, type ResourcesModel } from "../resources/model.ts";

import { pickCelestial } from "./celestial.ts";
import { foldConstellation, graphEvent, type ConstellationRecord } from "./constellation.ts";
import { purgeWorkspace } from "./removal.ts";
import { replyPreview } from "./replyPreview.ts";
import { replyText, userTurnAfter } from "./userTurns.ts";

export interface SessionRecord {
  readonly session: AgentSession;
  /** Set once the user renames the session; Harness title suggestions are then ignored. */
  readonly titleLocked: boolean;
  /**
   * The most recent Turns (at most `RECENT_TURNS`), ordered by `index`. The
   * session's `turnCount` counts all of them; older ones are in SQL.
   */
  readonly turns: ReadonlyArray<Turn>;
  readonly pending: ReadonlyMap<RequestId, ApprovalRequest>;
  /** Subagents still working; ended ones are in SQL (`EventStore.readSubagents`). */
  readonly subagents: ReadonlyMap<SubagentId, Subagent>;
}

export interface ReadModel {
  readonly constellations: ReadonlyMap<ConstellationId, ConstellationRecord>;
  /** Sequence of the last event folded in; 0 for an empty store. */
  readonly sequence: number;
  readonly hostResources?: ResourcesModel;
  readonly workspaces: ReadonlyMap<WorkspaceId, Workspace>;
  readonly worktrees: ReadonlyMap<WorktreeId, Worktree>;
  readonly sessions: ReadonlyMap<SessionId, SessionRecord>;
  /** Review Checkouts not yet removed. Risk Summaries and Verdicts are in SQL only (`review.ts`). */
  readonly reviewCheckouts: ReadonlyMap<ReviewCheckoutId, ReviewCheckout>;
}

export const emptyModel: ReadModel = {
  sequence: 0,
  hostResources: emptyResources(),
  constellations: new Map(),
  workspaces: new Map(),
  worktrees: new Map(),
  sessions: new Map(),
  reviewCheckouts: new Map(),
};

/** Turns kept per session in memory; the Turn in flight is the latest, so always among them. */
export const RECENT_TURNS = 32;

// ── Stream classification ───────────────────────────────────────────────────

const hostEvent = () => null;

const bySessionId = (event: { readonly sessionId: SessionId }) => event.sessionId;

const byTurn = (event: { readonly turn: Turn }) => event.turn.sessionId;

/** The Agent Session an event belongs to, or null for Host-level events. */
export const sessionOf: (event: DomainEvent) => SessionId | null =
  DomainEvent.match<SessionId | null>({
    ConstellationStarted: hostEvent,
    ConstellationStateChanged: hostEvent,
    LeadChanged: hostEvent,
    LeadHandoverRequested: hostEvent,
    LeadHandoverCancelled: hostEvent,
    AttemptInterrupted: hostEvent,
    AttemptStale: hostEvent,
    AttemptFresh: hostEvent,
    WorkerInputDelivered: hostEvent,
    TaskDeclared: hostEvent,
    TaskEdited: hostEvent,
    TaskCanceled: hostEvent,
    TaskProposed: hostEvent,
    ProposalAccepted: hostEvent,
    ProposalDeclined: hostEvent,
    AttemptStarted: hostEvent,
    AttemptProgressed: hostEvent,
    AttemptClaimed: hostEvent,
    ClaimApproved: hostEvent,
    ClaimHandedUp: hostEvent,
    AttemptBlocked: hostEvent,
    AttemptUnblocked: hostEvent,
    AttemptNudged: hostEvent,
    AttemptAccepted: hostEvent,
    AttemptRejected: hostEvent,
    AttemptSettled: hostEvent,
    GatePromoted: hostEvent,
    NotificationQueued: hostEvent,
    LeadNotified: hostEvent,
    OperatorMessageSent: hostEvent,
    OperatorMessageResolved: hostEvent,
    PeerMessage: hostEvent,
    AttemptRecoveryContinued: hostEvent,
    ResourceDeclared: hostEvent,
    ResourceRemoved: hostEvent,
    ResourceLeaseCanceled: hostEvent,
    ResourceLeaseQueued: hostEvent,
    ResourceLeased: hostEvent,
    ResourceReleased: hostEvent,

    WorkspaceRegistered: hostEvent,
    WorkspaceUpdated: hostEvent,
    WorkspaceRemoved: hostEvent,
    WorktreeDetected: hostEvent,
    WorktreeRemoved: hostEvent,
    SessionCreated: (event) => event.session.id,
    SessionStateChanged: bySessionId,
    SessionRenamed: bySessionId,
    SessionPinned: bySessionId,
    SessionResumeAtResetChanged: bySessionId,
    SessionCursorUpdated: bySessionId,
    SessionPermissionModeChanged: bySessionId,
    SessionModelChanged: bySessionId,
    SessionSetupChanged: bySessionId,
    SessionContextUsed: bySessionId,
    SessionCompacted: bySessionId,
    SessionNotified: bySessionId,
    SessionBackgroundTasksChanged: bySessionId,
    TurnStarted: byTurn,
    TurnItemCompleted: bySessionId,
    TurnEnded: byTurn,
    SubagentStarted: (event) => event.subagent.sessionId,
    SubagentEnded: (event) => event.subagent.sessionId,
    ApprovalRequested: (event) => event.request.sessionId,
    ApprovalResolved: bySessionId,
    ApprovalWithdrawn: bySessionId,
    CheckpointRecorded: bySessionId,
    TurnsAccepted: bySessionId,
    TurnsReverted: bySessionId,
    SessionPullRequestLinked: bySessionId,
    ReviewCheckoutOpened: hostEvent,
    ReviewCheckoutChanged: hostEvent,
    ReviewCheckoutRemoved: hostEvent,
    RiskSummaryStarted: hostEvent,
    RiskSummaryLayerChanged: hostEvent,
    RiskFindingsRecorded: hostEvent,
    RiskFindingResolved: hostEvent,
    RiskSummaryEnded: hostEvent,
    VerdictRecorded: hostEvent,
  });

/**
 * Event types the Host stream leaves out: per-item output, checkpoints and
 * context usage only matter to a Client that has the session open.
 */
export const sessionOnlyEventTypes: ReadonlyArray<DomainEvent["_tag"]> = [
  "TurnItemCompleted",
  "CheckpointRecorded",
  "SessionContextUsed",
  "SessionCompacted",
];

/**
 * Risk Summaries and Verdicts: recorded on the Host, but served by the
 * review RPCs (`review.watchRiskSummary`, `review.verdicts`), not the Host stream.
 */
export const reviewOnlyEventTypes: ReadonlyArray<DomainEvent["_tag"]> = [
  "RiskSummaryStarted",
  "RiskSummaryLayerChanged",
  "RiskFindingsRecorded",
  "RiskFindingResolved",
  "RiskSummaryEnded",
  "VerdictRecorded",
];

/**
 * A Constellation's contents: served by its own `constellation.subscribe` stream. The Host
 * stream keeps only the events that change its listing (started, state, Lead).
 */
export const constellationOnlyEventTypes: ReadonlyArray<DomainEvent["_tag"]> = [
  "TaskDeclared",
  "TaskEdited",
  "TaskCanceled",
  "TaskProposed",
  "ProposalAccepted",
  "ProposalDeclined",
  "AttemptStarted",
  "AttemptProgressed",
  "AttemptClaimed",
  "ClaimApproved",
  "ClaimHandedUp",
  "AttemptBlocked",
  "AttemptUnblocked",
  "AttemptNudged",
  "AttemptAccepted",
  "AttemptRejected",
  "AttemptSettled",
  "GatePromoted",
  "NotificationQueued",
  "LeadNotified",
  "OperatorMessageSent",
  "OperatorMessageResolved",
  "PeerMessage",
  "AttemptRecoveryContinued",
];

/** Everything the Host stream leaves out. */
export const hostOmittedEventTypes: ReadonlyArray<DomainEvent["_tag"]> = [
  ...sessionOnlyEventTypes,
  ...reviewOnlyEventTypes,
  ...constellationOnlyEventTypes,
];

export const isHostStreamEvent = (event: DomainEvent): boolean =>
  !hostOmittedEventTypes.includes(event._tag);

export { eventCapability, gatingCapabilities } from "./eventCapability.ts";

/**
 * Events only Clients that announced `session.subagents` get: a Subagent's
 * lifecycle and its own items. Older Clients would show those items as the Turn's.
 */
export const isSubagentEvent = (event: DomainEvent): boolean =>
  DomainEvent.matchOrElse(
    event,
    {
      SubagentStarted: () => true,
      SubagentEnded: () => true,
      TurnItemCompleted: (completed) => completed.subagentId !== null,
    },
    () => false
  );

// ── Helpers ─────────────────────────────────────────────────────────────────

export const lastTurn = (record: SessionRecord): Turn | undefined =>
  record.turns[record.turns.length - 1];

export const workingTurn = (record: SessionRecord): Turn | undefined =>
  record.turns.find((turn) => turn.status === "working");

export const checkpointLabel = (ref: string): "before" | "after" | null => {
  if (ref.endsWith("/before")) return "before";

  return ref.endsWith("/after") ? "after" : null;
};

export type SessionPatch = Partial<typeof AgentSession.Type>;

/** A copy of `session` with `patch` applied. */
export const patchSession = (session: AgentSession, patch: SessionPatch): AgentSession =>
  new AgentSession({
    id: session.id,
    workspaceId: session.workspaceId,
    harness: session.harness,
    title: session.title,
    cwd: session.cwd,
    worktreeId: session.worktreeId,
    state: session.state,
    permissionMode: session.permissionMode,
    model: session.model,
    effort: session.effort,
    serviceTier: session.serviceTier,
    celestial: session.celestial,
    parentSessionId: session.parentSessionId,
    forkedFromTurnId: session.forkedFromTurnId,
    harnessCursor: session.harnessCursor,
    turnCount: session.turnCount,
    currentUserTurn: session.currentUserTurn,
    lastReplyPreview: session.lastReplyPreview,
    contextUsage: session.contextUsage,
    lastCompaction: session.lastCompaction,
    backgroundTasks: session.backgroundTasks,
    backgroundChangedAt: session.backgroundChangedAt,
    worktreeSetup: session.worktreeSetup,
    lastError: session.lastError,
    acceptedThroughIndex: session.acceptedThroughIndex,
    pullRequest: session.pullRequest,
    origin: session.origin,
    worker: session.worker,
    pinnedAt: session.pinnedAt,
    limitResetsAt: session.limitResetsAt,
    resumeAtReset: session.resumeAtReset,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...patch,
  });

export type TurnPatch = Partial<typeof Turn.Type>;

/** A copy of `turn` with `patch` applied. */
export const patchTurn = (turn: Turn, patch: TurnPatch): Turn =>
  new Turn({
    id: turn.id,
    sessionId: turn.sessionId,
    index: turn.index,
    prompt: turn.prompt,
    trigger: turn.trigger,
    userTurnNumber: turn.userTurnNumber,
    replyPreview: turn.replyPreview,
    attachments: turn.attachments,
    model: turn.model,
    effort: turn.effort,
    serviceTier: turn.serviceTier,
    status: turn.status,
    feedback: turn.feedback,
    shellCommand: turn.shellCommand,
    idleCompaction: turn.idleCompaction,
    checkpointBefore: turn.checkpointBefore,
    checkpointAfter: turn.checkpointAfter,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    ...patch,
  });

const withMap = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V | undefined): Map<K, V> => {
  const next = new Map(map);

  if (value === undefined) next.delete(key);
  else next.set(key, value);

  return next;
};

const upsertTurn = (turns: ReadonlyArray<Turn>, turn: Turn): ReadonlyArray<Turn> => {
  const at = turns.findIndex((t) => t.id === turn.id);

  if (at === -1) {
    // A Turn older than every one in memory was evicted already and is final.
    if (turns.length >= RECENT_TURNS && turn.index < turns[0]!.index) return turns;
    const next = [...turns, turn].sort((a, b) => a.index - b.index);

    return next.length > RECENT_TURNS ? next.slice(next.length - RECENT_TURNS) : next;
  }

  const next = [...turns];
  next[at] = turn;

  return next;
};

// ── Reducer ─────────────────────────────────────────────────────────────────

/** The model an event is folded into, and what its envelope says about it. */
interface Fold {
  readonly model: ReadModel;
  readonly at: string;
  /** The event records a Client's command (it carries a command id). */
  readonly byClient: boolean;
}

type Reducer = (fold: Fold) => ReadModel;

/** What one event changes in a session's record; `session` patches its fields. */
interface RecordChange {
  readonly session?: SessionPatch;
  readonly titleLocked?: boolean;
  readonly turns?: ReadonlyArray<Turn>;
  readonly pending?: ReadonlyMap<RequestId, ApprovalRequest>;
  readonly subagents?: ReadonlyMap<SubagentId, Subagent>;
}

/** Apply `f`'s change to a session's record; every change also sets `updatedAt`. */
const updateSession = (
  fold: Fold,
  sessionId: SessionId,
  f: (record: SessionRecord) => RecordChange
): ReadModel => {
  const { model } = fold;
  const record = model.sessions.get(sessionId);

  if (record === undefined) return model;
  const change = f(record);

  const next: SessionRecord = {
    session: patchSession(record.session, { ...change.session, updatedAt: fold.at }),
    titleLocked: change.titleLocked ?? record.titleLocked,
    turns: change.turns ?? record.turns,
    pending: change.pending ?? record.pending,
    subagents: change.subagents ?? record.subagents,
  };

  return { ...model, sessions: withMap(model.sessions, sessionId, next) };
};

const setWorkspace =
  (event: { readonly workspace: Workspace }): Reducer =>
  ({ model }) => ({
    ...model,
    workspaces: withMap(model.workspaces, event.workspace.id, event.workspace),
  });

const removeWorkspace =
  (event: { readonly workspaceId: WorkspaceId }): Reducer =>
  ({ model }) =>
    purgeWorkspace(model, event.workspaceId);

const createSession =
  (event: { readonly session: AgentSession }): Reducer =>
  ({ model }) => ({
    ...model,
    sessions: withMap(model.sessions, event.session.id, {
      // A session logged before Celestials gets the planet it would have been given.
      session:
        event.session.celestial == null
          ? patchSession(event.session, {
              celestial: pickCelestial(model.sessions.values(), event.session),
            })
          : event.session,
      titleLocked: false,
      turns: [],
      pending: new Map(),
      subagents: new Map(),
    }),
  });

const resourceProjection =
  (event: DomainEvent): Reducer =>
  ({ model, at }) => {
    const current = model.hostResources ?? emptyResources();

    const hostResources = foldResources(
      {
        resources: new Map(current.resources),
        leases: new Map(current.leases),
        waiting: new Map(current.waiting),
      },
      [{ event, occurredAt: at }]
    );

    return { ...model, hostResources };
  };

/** A Turn's start or end; its user-Turn number and reply preview come from the fold, not the event. */
const recordTurn =
  (started: boolean) =>
  ({ turn }: { readonly turn: Turn }): Reducer =>
  (fold) =>
    updateSession(fold, turn.sessionId, (r) => {
      const known = r.turns.find((t) => t.id === turn.id);

      const opened =
        started && known === undefined
          ? userTurnAfter(r.session.currentUserTurn, {
              id: turn.id,
              startedAt: turn.startedAt,
              harnessStarted: turn.trigger !== null || turn.idleCompaction === true,
            })
          : null;

      const kept = patchTurn(turn, {
        userTurnNumber: known?.userTurnNumber ?? opened?.number ?? turn.userTurnNumber,
        replyPreview: known?.replyPreview ?? turn.replyPreview,
      });

      // Idle compaction's Turn leaves the reply the user last read.
      const quiet = started || kept.idleCompaction === true;

      return {
        session: {
          // Turn indexes are dense from 0, so the count is one past the highest seen.
          turnCount: Math.max(r.session.turnCount, turn.index + 1),
          currentUserTurn: opened ?? r.session.currentUserTurn,
          lastReplyPreview: quiet ? r.session.lastReplyPreview : kept.replyPreview,
        },
        turns: upsertTurn(r.turns, kept),
      };
    });

/** The working Turn's own reply sets its preview; `updatedAt` stays, as the Host stream omits it. */
const recordReply =
  (event: Extract<DomainEvent, { readonly _tag: "TurnItemCompleted" }>): Reducer =>
  ({ model }) => {
    const text = replyText(event);
    const record = text === null ? undefined : model.sessions.get(event.sessionId);
    const turn = record?.turns.find((t) => t.id === event.turnId && t.status === "working");
    const preview = text === null || turn === undefined ? null : replyPreview(text);

    if (record === undefined || turn === undefined || preview === null) return model;

    const turns = upsertTurn(record.turns, patchTurn(turn, { replyPreview: preview }));

    return { ...model, sessions: withMap(model.sessions, event.sessionId, { ...record, turns }) };
  };

const recordCheckpoint =
  (event: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly ref: string;
  }): Reducer =>
  (fold) => {
    const label = checkpointLabel(event.ref);

    if (label === null) return fold.model;

    return updateSession(fold, event.sessionId, (r) => {
      const turn = r.turns.find((t) => t.id === event.turnId);

      if (turn === undefined) return {};

      const updated = patchTurn(
        turn,
        label === "before" ? { checkpointBefore: event.ref } : { checkpointAfter: event.ref }
      );

      return { turns: upsertTurn(r.turns, updated) };
    });
  };

const resolveRequest =
  (event: { readonly sessionId: SessionId; readonly requestId: RequestId }): Reducer =>
  (fold) =>
    updateSession(fold, event.sessionId, (r) => ({
      pending: withMap(r.pending, event.requestId, undefined),
    }));

const setCheckout =
  ({ checkout }: { readonly checkout: ReviewCheckout }): Reducer =>
  ({ model }) => ({
    ...model,
    reviewCheckouts: withMap(model.reviewCheckouts, checkout.id, checkout),
  });

const keep: Reducer = ({ model }) => model;

const apply: (event: DomainEvent) => Reducer = DomainEvent.match<Reducer>({
  // Constellation projections are folded separately by their graph decider.
  ConstellationStarted: () => keep,
  ConstellationStateChanged: () => keep,
  LeadChanged: () => keep,
  LeadHandoverRequested: () => keep,
  LeadHandoverCancelled: () => keep,
  AttemptInterrupted: () => keep,
  AttemptStale: () => keep,
  AttemptFresh: () => keep,
  WorkerInputDelivered: () => keep,
  TaskDeclared: () => keep,
  TaskEdited: () => keep,
  TaskCanceled: () => keep,
  TaskProposed: () => keep,
  ProposalAccepted: () => keep,
  ProposalDeclined: () => keep,
  AttemptStarted: () => keep,
  AttemptProgressed: () => keep,
  AttemptClaimed: () => keep,
  ClaimApproved: () => keep,
  ClaimHandedUp: () => keep,
  AttemptBlocked: () => keep,
  AttemptUnblocked: () => keep,
  AttemptNudged: () => keep,
  AttemptAccepted: () => keep,
  AttemptRejected: () => keep,
  AttemptSettled: () => keep,
  GatePromoted: () => keep,
  NotificationQueued: () => keep,
  LeadNotified: () => keep,
  OperatorMessageSent: () => keep,
  OperatorMessageResolved: () => keep,
  PeerMessage: () => keep,
  AttemptRecoveryContinued: () => keep,
  ResourceDeclared: resourceProjection,
  ResourceRemoved: resourceProjection,
  ResourceLeaseCanceled: resourceProjection,
  ResourceLeaseQueued: resourceProjection,
  ResourceLeased: resourceProjection,
  ResourceReleased: resourceProjection,

  WorkspaceRegistered: setWorkspace,
  WorkspaceUpdated: setWorkspace,
  WorkspaceRemoved: removeWorkspace,
  WorktreeDetected:
    ({ worktree }) =>
    ({ model }) => ({ ...model, worktrees: withMap(model.worktrees, worktree.id, worktree) }),
  WorktreeRemoved:
    ({ worktreeId }) =>
    ({ model }) => ({ ...model, worktrees: withMap(model.worktrees, worktreeId, undefined) }),
  SessionCreated: createSession,
  SessionStateChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, (r) => ({
      session: {
        state: event.state,
        lastError: event.state === "failed" ? event.reason : r.session.lastError,
        limitResetsAt: event.state === "limited" ? (event.resetsAt ?? null) : null,
      },
    })),
  SessionRenamed: (event) => (fold) =>
    updateSession(fold, event.sessionId, (r) => ({
      // A rename a Client asked for (it carries a command id) locks the title.
      titleLocked: r.titleLocked || fold.byClient,
      session: { title: event.title },
    })),
  SessionPinned: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({ session: { pinnedAt: event.pinnedAt } })),
  SessionResumeAtResetChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({
      session: { resumeAtReset: event.resumeAtReset },
    })),
  SessionCursorUpdated: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({
      session: { harnessCursor: event.harnessCursor },
    })),
  SessionPermissionModeChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({
      session: { permissionMode: event.permissionMode },
    })),
  SessionModelChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, (record) => ({
      session: {
        model: event.model,
        effort: event.effort,
        serviceTier: event.serviceTier ?? record.session.serviceTier,
      },
    })),
  SessionSetupChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({ session: { worktreeSetup: event.setup } })),
  SessionContextUsed: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({ session: { contextUsage: event.usage } })),
  SessionBackgroundTasksChanged: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({
      session: { backgroundTasks: event.tasks, backgroundChangedAt: fold.at },
    })),
  SessionCompacted: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({ session: { lastCompaction: event.compaction } })),
  /** Only Clients act on it; the read model keeps nothing. */
  SessionNotified:
    () =>
    ({ model }) =>
      model,
  TurnStarted: recordTurn(true),
  TurnEnded: recordTurn(false),
  TurnItemCompleted: recordReply,
  CheckpointRecorded: recordCheckpoint,
  ApprovalRequested:
    ({ request }) =>
    (fold) =>
      updateSession(fold, request.sessionId, (r) => ({
        pending: withMap(r.pending, request.id, request),
      })),
  ApprovalResolved: resolveRequest,
  ApprovalWithdrawn: resolveRequest,
  SubagentStarted:
    ({ subagent }) =>
    (fold) =>
      updateSession(fold, subagent.sessionId, (r) => ({
        subagents: withMap(r.subagents, subagent.id, subagent),
      })),
  SubagentEnded:
    ({ subagent }) =>
    (fold) =>
      updateSession(fold, subagent.sessionId, (r) => ({
        subagents: withMap(r.subagents, subagent.id, undefined),
      })),
  TurnsAccepted: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({
      session: { acceptedThroughIndex: event.throughIndex },
    })),
  TurnsReverted: (event) => (fold) => updateSession(fold, event.sessionId, () => ({})),
  SessionPullRequestLinked: (event) => (fold) =>
    updateSession(fold, event.sessionId, () => ({ session: { pullRequest: event.pullRequest } })),
  ReviewCheckoutOpened: setCheckout,
  ReviewCheckoutChanged: setCheckout,
  ReviewCheckoutRemoved:
    ({ checkoutId }) =>
    ({ model }) => ({
      ...model,
      reviewCheckouts: withMap(model.reviewCheckouts, checkoutId, undefined),
    }),
  // Review-only events change SQL (`review.ts`), not the read model.
  RiskSummaryStarted: () => keep,
  RiskSummaryLayerChanged: () => keep,
  RiskFindingsRecorded: () => keep,
  RiskFindingResolved: () => keep,
  RiskSummaryEnded: () => keep,
  VerdictRecorded: () => keep,
});

export const project = (model: ReadModel, envelope: EventEnvelope): ReadModel => {
  const graph = graphEvent(envelope.event);

  if (graph !== null) {
    const folded = foldConstellation(
      model.constellations.get(graph.constellationId),
      graph,
      envelope.occurredAt
    );

    return {
      ...model,
      sequence: envelope.sequence,
      constellations:
        folded === undefined
          ? model.constellations
          : new Map([...model.constellations, [graph.constellationId, folded]]),
    };
  }

  const next = apply(envelope.event)({
    model,
    at: envelope.occurredAt,
    byClient: envelope.commandId !== null,
  });

  return { ...next, sequence: envelope.sequence };
};

/**
 * Fold events into one session's record exactly as `project` would, without
 * the rest of the model. The session lifecycle machine (`engine/session.ts`)
 * updates its context with it, so its snapshot is always the one the log folds to.
 */
export const foldSession = (
  sessionId: SessionId,
  record: SessionRecord | undefined,
  events: ReadonlyArray<DomainEvent>,
  occurredAt: string
): SessionRecord | undefined => {
  let model: ReadModel = {
    ...emptyModel,
    sessions: record === undefined ? new Map() : new Map([[sessionId, record]]),
  };

  for (const event of events) model = apply(event)({ model, at: occurredAt, byClient: false });

  return model.sessions.get(sessionId);
};
