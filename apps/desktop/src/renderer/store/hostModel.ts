/**
 * One Host's read model in the renderer: its Workspaces, Worktrees and Agent
 * Sessions (with pending approvals), folded from the host feed exactly as the
 * Daemon folds its log (`apps/daemon/src/store/model.ts`). A Snapshot resets it.
 */
import type {
  CurrentUserTurn,
  HostResource,
  ResourceEvent,
  ResourceLease,
  Sequence,
  ApprovalDecision,
  ApprovalRequest,
  Subagent,
  DomainEvent,
  EventEnvelope,
  HostStreamItem,
  ReviewCheckout,
  SessionNotification,
  Turn,
  Workspace,
  Worktree,
} from "@polaris/protocol";
import type { UserTurn } from "../../shared/needsYou.ts";
import { Match } from "effect";
import { applyResourceEvent, type HostResources, resourcesFromSnapshot } from "./hostResources.ts";
import type { SessionData } from "./plain.ts";

/** An approval a Client answered: who, when, and what it was (for "Answered on <device>"). */
export interface ResolvedApproval {
  readonly request: ApprovalRequest;
  /** The device label of the Client that answered first (`ApprovalResolved.resolvedBy`). */
  readonly resolvedBy: string;
  readonly decision: ApprovalDecision["_tag"];
  readonly at: string;
}

/** How many resolutions a session keeps. */
const RESOLVED_KEPT = 3;

export interface SessionEntry {
  readonly session: SessionData;
  readonly pendingApprovals: ReadonlyArray<ApprovalRequest>;
  /** The latest resolutions this Client saw live, newest last; not in snapshots. */
  readonly resolved?: ReadonlyArray<ResolvedApproval>;
  readonly lastTurnPreview: string | null;
  /** The latest Turn's id, seen live; snapshots don't carry it. */
  readonly lastTurnId?: string | null;
  /** The latest Turn the user prompted (no `trigger`), seen live; snapshots don't carry it. */
  readonly userTurn?: UserTurn | undefined;
  /** The latest notification an agent sent from this session (`notify`), seen live. */
  readonly lastNotification?: SessionNotification;
  /** Subagents still working in this session. */
  readonly subagents: ReadonlyArray<Subagent>;
}

export interface HostModel {
  readonly sequence: Sequence;
  /** False until the feed says everything up to now has arrived (or while painted from cache). */
  readonly synchronized: boolean;
  /** Painted from the last cached snapshot; replaced by the first live Snapshot. */
  readonly fromCache: boolean;
  readonly workspaces: ReadonlyMap<string, Workspace>;
  readonly worktrees: ReadonlyMap<string, Worktree>;
  readonly sessions: ReadonlyMap<string, SessionEntry>;
  /** Review Checkouts on this Host, by id. */
  readonly reviewCheckouts: ReadonlyMap<string, ReviewCheckout>;
  /** Resources, leases and the queue on this Host (C1-R). */
  readonly resources: HostResources;
}

export const emptyHostModel: HostModel = {
  // SAFETY: sequences start at 1, so 0 precedes every real one.
  sequence: 0 as Sequence,
  synchronized: false,
  fromCache: false,
  workspaces: new Map(),
  worktrees: new Map(),
  sessions: new Map(),
  reviewCheckouts: new Map(),
  resources: resourcesFromSnapshot(),
};

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined) => {
  const next = new Map(map);

  if (value === undefined) next.delete(key);
  else next.set(key, value);

  return next;
};

const entryOf = (summary: SessionEntry): SessionEntry => ({
  session: summary.session,
  pendingApprovals: summary.pendingApprovals,
  lastTurnPreview: summary.lastTurnPreview,
  subagents: summary.subagents,
});

type SessionChange = (entry: SessionEntry) => SessionEntry;

interface SessionUpdate {
  readonly model: HostModel;
  readonly sessionId: string;
  readonly at: string;
  readonly change: SessionChange;
}

/** Applies `change` to a session's entry and stamps `updatedAt`; unknown sessions are ignored. */
const updateSession = ({ model, sessionId, at, change }: SessionUpdate): HostModel => {
  const entry = model.sessions.get(sessionId);

  if (entry === undefined) return model;
  const next = change(entry);

  return {
    ...model,
    sessions: withEntry(model.sessions, sessionId, {
      ...next,
      session: { ...next.session, updatedAt: at },
    }),
  };
};

const patch =
  (fields: Partial<SessionData>): SessionChange =>
  (entry) => ({ ...entry, session: { ...entry.session, ...fields } });

const withoutRequest =
  (requestId: string): SessionChange =>
  (entry) => ({
    ...entry,
    pendingApprovals: entry.pendingApprovals.filter((r) => r.id !== requestId),
  });

type Fold = (model: HostModel, at: string) => HostModel;

const onSession =
  (sessionId: string, change: SessionChange): Fold =>
  (model, at) =>
    updateSession({ model, sessionId, at, change });

type TurnFacts = Pick<Turn, "id" | "sessionId" | "index" | "prompt" | "startedAt"> &
  Partial<Pick<Turn, "trigger" | "userTurnNumber" | "replyPreview" | "idleCompaction">>;

/** The Daemon's user Turn (`session.user-turns`): a Turn with a higher number opens the next one. */
const currentUserTurn = (session: SessionData, turn: TurnFacts): CurrentUserTurn | null => {
  const number = turn.userTurnNumber ?? null;
  const current = session.currentUserTurn ?? null;

  return number !== null && number > (current?.number ?? 0)
    ? { turnId: turn.id, number, startedAt: turn.startedAt }
    : current;
};

/** Idle compaction's Turn moves nothing the user reads: the last prompt and reply stay. */
const onCompactionTurn = (turn: TurnFacts) =>
  onSession(turn.sessionId, (entry) => ({
    ...entry,
    lastTurnId: turn.id,
    session: { ...entry.session, turnCount: Math.max(entry.session.turnCount, turn.index + 1) },
  }));

const onUserOrHarnessTurn = (turn: TurnFacts, ended: boolean) =>
  onSession(turn.sessionId, (entry) => ({
    ...entry,
    lastTurnPreview: turn.prompt.slice(0, 140),
    lastTurnId: turn.id,
    userTurn:
      turn.trigger == null
        ? { id: turn.id, startedAt: turn.startedAt, prompt: turn.prompt.slice(0, 140) }
        : entry.userTurn,
    session: {
      ...entry.session,
      turnCount: Math.max(entry.session.turnCount, turn.index + 1),
      currentUserTurn: currentUserTurn(entry.session, turn),
      lastReplyPreview: ended
        ? (turn.replyPreview ?? null)
        : (entry.session.lastReplyPreview ?? null),
    },
  }));

const onTurn = (turn: TurnFacts, ended: boolean) =>
  turn.idleCompaction === true ? onCompactionTurn(turn) : onUserOrHarnessTurn(turn, ended);

const removeWorkspace =
  (workspaceId: string): Fold =>
  (model) => ({
    ...model,
    workspaces: withEntry(model.workspaces, workspaceId, undefined),
    worktrees: new Map([...model.worktrees].filter(([, wt]) => wt.workspaceId !== workspaceId)),
    // Removal purges its sessions, archived ones included (docs/adr/0086).
    sessions: new Map(
      [...model.sessions].filter(([, entry]) => entry.session.workspaceId !== workspaceId)
    ),
  });

const unchanged: Fold = (model) => model;

const onResources =
  (event: ResourceEvent): Fold =>
  (model, at) => ({
    ...model,
    resources: applyResourceEvent(model.resources, event, at),
  });

const withCheckout =
  (checkoutId: string, checkout: ReviewCheckout | undefined): Fold =>
  (model) => ({
    ...model,
    reviewCheckouts: withEntry(model.reviewCheckouts, checkoutId, checkout),
  });

const fold = (event: DomainEvent): Fold =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      // Constellation events are projected in their own view.
      ConstellationStarted: () => unchanged,
      ConstellationStateChanged: () => unchanged,
      LeadChanged: () => unchanged,
      LeadHandoverRequested: () => unchanged,
      LeadHandoverCancelled: () => unchanged,
      AttemptInterrupted: () => unchanged,
      AttemptStale: () => unchanged,
      AttemptFresh: () => unchanged,
      WorkerInputDelivered: () => unchanged,
      TaskDeclared: () => unchanged,
      TaskEdited: () => unchanged,
      TaskCanceled: () => unchanged,
      TaskProposed: () => unchanged,
      ProposalAccepted: () => unchanged,
      ProposalDeclined: () => unchanged,
      AttemptStarted: () => unchanged,
      AttemptProgressed: () => unchanged,
      ClaimApproved: () => unchanged,
      ClaimHandedUp: () => unchanged,
      AttemptBlocked: () => unchanged,
      AttemptUnblocked: () => unchanged,
      AttemptNudged: () => unchanged,
      AttemptClaimed: () => unchanged,
      AttemptAccepted: () => unchanged,
      AttemptRejected: () => unchanged,
      AttemptSettled: () => unchanged,
      GatePromoted: () => unchanged,
      NotificationQueued: () => unchanged,
      LeadNotified: () => unchanged,
      OperatorMessageSent: () => unchanged,
      OperatorMessageResolved: () => unchanged,
      PeerMessage: () => unchanged,
      AttemptRecoveryContinued: () => unchanged,
      ResourceDeclared: onResources,
      ResourceRemoved: onResources,
      ResourceLeaseCanceled: onResources,
      ResourceLeaseQueued: onResources,
      ResourceLeased: onResources,
      ResourceReleased: onResources,

      WorkspaceRegistered:
        ({ workspace }): Fold =>
        (m) => ({
          ...m,
          workspaces: withEntry(m.workspaces, workspace.id, workspace),
        }),
      WorkspaceUpdated:
        ({ workspace }): Fold =>
        (m) => ({
          ...m,
          workspaces: withEntry(m.workspaces, workspace.id, workspace),
        }),
      WorkspaceRemoved: ({ workspaceId }) => removeWorkspace(workspaceId),
      WorktreeDetected:
        ({ worktree }): Fold =>
        (m) => ({
          ...m,
          worktrees: withEntry(m.worktrees, worktree.id, worktree),
        }),
      WorktreeRemoved:
        ({ worktreeId }): Fold =>
        (m) => ({
          ...m,
          worktrees: withEntry(m.worktrees, worktreeId, undefined),
        }),
      SessionCreated:
        ({ session }): Fold =>
        (m) => ({
          ...m,
          sessions: withEntry(m.sessions, session.id, {
            session,
            pendingApprovals: [],
            lastTurnPreview: null,
            subagents: [],
          }),
        }),
      SessionStateChanged: ({ sessionId, state, reason, resetsAt }) =>
        onSession(sessionId, (entry) =>
          patch({
            state,
            lastError: state === "failed" ? reason : entry.session.lastError,
            limitResetsAt: state === "limited" ? (resetsAt ?? null) : null,
          })(entry)
        ),
      SessionRenamed: ({ sessionId, title }) => onSession(sessionId, patch({ title })),
      SessionPinned: ({ sessionId, pinnedAt }) => onSession(sessionId, patch({ pinnedAt })),
      SessionResumeAtResetChanged: ({ sessionId, resumeAtReset }) =>
        onSession(sessionId, patch({ resumeAtReset })),
      SessionCursorUpdated: ({ sessionId, harnessCursor }) =>
        onSession(sessionId, patch({ harnessCursor })),
      SessionModelChanged: ({ sessionId, model, effort, serviceTier }) =>
        onSession(sessionId, (entry) =>
          patch({ model, effort, serviceTier: serviceTier ?? entry.session.serviceTier })(entry)
        ),
      SessionPermissionModeChanged: ({ sessionId, permissionMode }) =>
        onSession(sessionId, patch({ permissionMode })),
      SessionSetupChanged: ({ sessionId, setup }) =>
        onSession(sessionId, patch({ worktreeSetup: setup })),
      SessionContextUsed: ({ sessionId, usage }) =>
        onSession(sessionId, patch({ contextUsage: usage })),
      SessionBackgroundTasksChanged: ({ sessionId, tasks }) =>
        onSession(sessionId, patch({ backgroundTasks: tasks })),
      SessionCompacted: ({ sessionId, compaction }) =>
        onSession(sessionId, patch({ lastCompaction: compaction })),
      SessionNotified: ({ sessionId, notification }) =>
        onSession(sessionId, (entry) => ({ ...entry, lastNotification: notification })),
      TurnStarted: ({ turn }) => onTurn(turn, false),
      TurnEnded: ({ turn }) => onTurn(turn, true),
      TurnItemCompleted: () => unchanged,
      SubagentStarted: () => unchanged,
      SubagentEnded: () => unchanged,
      CheckpointRecorded: () => unchanged,
      TurnsAccepted: ({ sessionId, throughIndex, throughUserTurn }) =>
        onSession(
          sessionId,
          patch({ acceptedThroughIndex: throughIndex, acceptedThroughUserTurn: throughUserTurn })
        ),
      TurnsReverted: () => unchanged,
      SessionPullRequestLinked: ({ sessionId, pullRequest }) =>
        onSession(sessionId, patch({ pullRequest })),
      ReviewCheckoutOpened: ({ checkout }) => withCheckout(checkout.id, checkout),
      ReviewCheckoutChanged: ({ checkout }) => withCheckout(checkout.id, checkout),
      ReviewCheckoutRemoved: ({ checkoutId }) => withCheckout(checkoutId, undefined),
      // Risk Summaries and Verdicts are review-only: the Review UI keeps its own (M2-F).
      RiskSummaryStarted: () => unchanged,
      RiskSummaryLayerChanged: () => unchanged,
      RiskFindingsRecorded: () => unchanged,
      RiskFindingResolved: () => unchanged,
      RiskSummaryEnded: () => unchanged,
      VerdictRecorded: () => unchanged,
      ApprovalRequested: ({ request }) =>
        onSession(request.sessionId, (entry) => ({
          ...entry,
          pendingApprovals: [...withoutRequest(request.id)(entry).pendingApprovals, request],
        })),
      ApprovalResolved:
        ({ sessionId, requestId, resolvedBy, decision }): Fold =>
        (m, at) =>
          updateSession({
            model: m,
            sessionId,
            at,
            change: (entry) => {
              const request = entry.pendingApprovals.find((r) => r.id === requestId);
              const next = withoutRequest(requestId)(entry);

              if (request === undefined) return next;
              const resolution = { request, resolvedBy, decision: decision._tag, at };

              return {
                ...next,
                resolved: [...(entry.resolved ?? []), resolution].slice(-RESOLVED_KEPT),
              };
            },
          }),
      ApprovalWithdrawn: ({ sessionId, requestId }) =>
        onSession(sessionId, withoutRequest(requestId)),
    })
  );

export const applyEnvelope = (model: HostModel, envelope: EventEnvelope): HostModel => {
  // Resumed feeds never repeat a sequence; this guards a replayed cache.
  if (envelope.sequence <= model.sequence) return model;

  return { ...fold(envelope.event)(model, envelope.occurredAt), sequence: envelope.sequence };
};

export interface HostSnapshot {
  readonly sequence: Sequence;
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly worktrees: ReadonlyArray<Worktree>;
  readonly sessions: ReadonlyArray<SessionEntry>;
  readonly reviewCheckouts?: ReadonlyArray<ReviewCheckout>;
  readonly resources?: ReadonlyArray<HostResource>;
  readonly resourceLeases?: ReadonlyArray<ResourceLease>;
}

/** A Snapshot resets the model; so does a cached one, marked `fromCache` by its caller. */
export const modelFromSnapshot = (snapshot: HostSnapshot): HostModel => ({
  sequence: snapshot.sequence,
  synchronized: false,
  fromCache: false,
  workspaces: new Map(snapshot.workspaces.map((w) => [w.id, w])),
  worktrees: new Map(snapshot.worktrees.map((w) => [w.id, w])),
  sessions: new Map(snapshot.sessions.map((s) => [s.session.id, entryOf(s)])),
  reviewCheckouts: new Map((snapshot.reviewCheckouts ?? []).map((c) => [c.id, c])),
  resources: resourcesFromSnapshot(snapshot.resources, snapshot.resourceLeases),
});

export const applyHostItem = (model: HostModel, item: HostStreamItem): HostModel =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot) => modelFromSnapshot(snapshot),
      Event: ({ envelope }) => applyEnvelope(model, envelope),
      Synchronized: (): HostModel => ({ ...model, synchronized: true }),
    })
  );

export const applyHostItems = (model: HostModel, items: ReadonlyArray<HostStreamItem>) =>
  items.reduce(applyHostItem, model);

/** Sessions of a Workspace, most recently updated first; archived ones left out. */
export const sessionsOf = (model: HostModel, workspaceId: string): ReadonlyArray<SessionEntry> =>
  [...model.sessions.values()]
    .filter((e) => e.session.workspaceId === workspaceId && e.session.state !== "archived")
    .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt));

/** Visible Workspaces in registration order. */
export const visibleWorkspaces = (model: HostModel): ReadonlyArray<Workspace> =>
  [...model.workspaces.values()]
    .filter((w) => !w.hidden)
    .sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
