/**
 * One open Agent Session in the renderer: the session, its Turns with their
 * completed items (in the order they started), pending approvals, and the live
 * state of items still in progress (`Delta` text and `ItemProgress`).
 */
import {
  type Sequence,
  type ApprovalDecision,
  type ApprovalRequest,
  type DomainEvent,
  type EventEnvelope,
  inStartOrder,
  placeItem,
  type SessionStreamItem,
  type Subagent,
  type Turn,
  type TurnDetail,
  type TurnItem,
  type TurnPage,
} from "@polaris/protocol";
import { Match } from "effect";
import type { SessionData } from "./plain.ts";

/** An item still in progress: the latest `ItemProgress`, plus text streamed as deltas. */
export interface LiveItem {
  readonly item: TurnItem | null;
  readonly text: string;
  readonly output: string;
}

/** A Subagent the Turn spawned, with its own items (completed and in progress). */
export interface SubagentView {
  readonly subagent: Subagent;
  readonly items: ReadonlyArray<TurnItem>;
  readonly live: ReadonlyMap<string, LiveItem>;
}

export interface TurnView {
  readonly turn: Turn;
  /** Completed items, in the order they started (`placeItem`). */
  readonly items: ReadonlyArray<TurnItem>;
  /** Keyed by item id; an item leaves when its `TurnItemCompleted` arrives. */
  readonly live: ReadonlyMap<string, LiveItem>;
  /** The Subagents it spawned, in the order they started; their items never mix with the Turn's. */
  readonly subagents: ReadonlyArray<SubagentView>;
}

export interface SessionModel {
  readonly sequence: Sequence;
  readonly synchronized: boolean;
  readonly session: SessionData | null;
  readonly turns: ReadonlyArray<TurnView>;
  readonly pendingApprovals: ReadonlyArray<ApprovalRequest>;
  /** Secret Requests that ended while this feed was open, so their cards say how (ADR 0089). */
  readonly settledSecrets?: ReadonlyArray<SettledSecret>;
  /** Write approvals answered or withdrawn while this feed was open: their cards collapse to a line. */
  readonly settledWrites?: ReadonlyArray<SettledWrite>;
}

/** How a Secret Request ended: its value saved, declined, or withdrawn (a timeout too). */
export type SecretOutcome = "provided" | "declined" | "ended";

export interface SettledSecret {
  readonly request: ApprovalRequest;
  readonly outcome: SecretOutcome;
}

/** How a write approval ended: allowed, denied with the user's reason, or withdrawn unanswered. */
export type WriteOutcome =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string | null }
  | {
      readonly kind: "expired";
      readonly by: "harness" | "daemon";
      /** The Daemon's withdrawal reason ("Interrupted", "The Turn ended"); null in older logs. */
      readonly reason: string | null;
    };

export interface SettledWrite {
  readonly request: ApprovalRequest;
  readonly outcome: WriteOutcome;
}

export const emptySessionModel: SessionModel = {
  // SAFETY: sequences start at 1, so 0 precedes every real one.
  sequence: 0 as Sequence,
  synchronized: false,
  session: null,
  turns: [],
  pendingApprovals: [],
};

const noLive: ReadonlyMap<string, LiveItem> = new Map();

/** A Turn as a Snapshot or a page of history sends it, with its items placed by start. */
const turnViewOf = (detail: TurnDetail): TurnView => ({
  turn: detail.turn,
  items: inStartOrder(detail.items),
  live: noLive,
  subagents: detail.subagents.map(({ subagent, items }) => ({
    subagent,
    items: inStartOrder(items),
    live: noLive,
  })),
});

const updateTurn = (
  model: SessionModel,
  turnId: string,
  change: (view: TurnView) => TurnView
): SessionModel => {
  const at = model.turns.findIndex((t) => t.turn.id === turnId);

  if (at === -1) return model;

  return { ...model, turns: model.turns.map((t, i) => (i === at ? change(t) : t)) };
};

const upsertTurn = (model: SessionModel, turn: Turn): SessionModel => {
  const at = model.turns.findIndex((t) => t.turn.id === turn.id);

  if (at !== -1) return updateTurn(model, turn.id, (view) => ({ ...view, turn }));

  const turns = [...model.turns, { turn, items: [], live: noLive, subagents: [] }].sort(
    (a, b) => a.turn.index - b.turn.index
  );

  return { ...model, turns };
};

const patchSession = (model: SessionModel, fields: Partial<SessionData>): SessionModel =>
  model.session === null ? model : { ...model, session: { ...model.session, ...fields } };

const withoutRequest = (model: SessionModel, requestId: string): SessionModel => ({
  ...model,
  pendingApprovals: model.pendingApprovals.filter((r) => r.id !== requestId),
});

/** An Allow or Answer can't settle a secret (the Daemon refuses both), so it reads as ended. */
const secretOutcomeOf = (decision: ApprovalDecision): SecretOutcome =>
  Match.value(decision).pipe(
    Match.tag("Provided", () => "provided" as const),
    Match.tag("Deny", () => "declined" as const),
    Match.orElse(() => "ended" as const)
  );

/** Older logs record a withdrawal as a Deny answered by "Harness" or "Daemon" (events.ts). */
const legacyWithdrawn = (resolvedBy: string): "harness" | "daemon" | undefined => {
  if (resolvedBy === "Harness") return "harness";

  return resolvedBy === "Daemon" ? "daemon" : undefined;
};

const writeOutcomeOf = (decision: ApprovalDecision, resolvedBy: string): WriteOutcome => {
  const legacy = legacyWithdrawn(resolvedBy);

  return Match.value(decision).pipe(
    Match.tag("Allow", (): WriteOutcome => ({ kind: "allowed" })),
    Match.tag("Deny", ({ reason }): WriteOutcome =>
      legacy === undefined
        ? { kind: "denied", reason }
        : { kind: "expired", by: legacy, reason: null }
    ),
    Match.orElse((): WriteOutcome => ({ kind: "expired", by: "daemon", reason: null }))
  );
};

interface Ending {
  readonly secret: SecretOutcome;
  readonly write: WriteOutcome;
}

/** Drops the request from pending; a Secret Request or a write is kept, settled, so its card stays. */
const settle = (model: SessionModel, requestId: string, ending: Ending): SessionModel => {
  const request = model.pendingApprovals.find((r) => r.id === requestId);
  const next = withoutRequest(model, requestId);

  if (request?.dataWrite !== undefined)
    return {
      ...next,
      settledWrites: [...(model.settledWrites ?? []), { request, outcome: ending.write }],
    };

  if (request?.kind !== "secret") return next;

  return {
    ...next,
    settledSecrets: [...(model.settledSecrets ?? []), { request, outcome: ending.secret }],
  };
};

/** Turn or Subagent: what holds items and their live progress. */
export interface Holder {
  readonly items: ReadonlyArray<TurnItem>;
  readonly live: ReadonlyMap<string, LiveItem>;
}

const completeItem = <H extends Holder>(view: H, item: TurnItem): H => {
  const live = new Map(view.live);

  live.delete(item.id);

  return { ...view, items: placeItem(view.items, item), live };
};

/** One row of a Turn or Subagent: a completed item, or one still in progress. */
export type TurnEntry =
  | { readonly kind: "completed"; readonly id: string; readonly item: TurnItem }
  | { readonly kind: "live"; readonly id: string; readonly live: LiveItem };

const startOfEntry = (entry: TurnEntry): string | null =>
  entry.kind === "completed" ? entry.item.startedAt : (entry.live.item?.startedAt ?? null);

/**
 * Completed and live items together, in the order they started. A live item still
 * streaming only text has no start yet and goes last.
 */
export const entriesInStartOrder = (view: Holder): ReadonlyArray<TurnEntry> => {
  const entries: Array<TurnEntry> = view.items.map((item) => ({
    kind: "completed",
    id: item.id,
    item,
  }));

  for (const [id, live] of view.live) {
    const entry: TurnEntry = { kind: "live", id, live };
    const start = startOfEntry(entry);

    const before =
      start === null
        ? -1
        : entries.findIndex((e) => {
            const other = startOfEntry(e);

            return other !== null && other > start;
          });

    entries.splice(before === -1 ? entries.length : before, 0, entry);
  }

  return entries;
};

/** Changes one Subagent of a Turn; a no-op when the Turn or the Subagent isn't known. */
const updateSubagent = (
  model: SessionModel,
  turnId: string,
  subagentId: string,
  change: (view: SubagentView) => SubagentView
): SessionModel =>
  updateTurn(model, turnId, (view) => {
    const at = view.subagents.findIndex((s) => s.subagent.id === subagentId);

    if (at === -1) return view;

    return { ...view, subagents: view.subagents.map((s, i) => (i === at ? change(s) : s)) };
  });

/** A Subagent started (or was restated): added to its Turn, or its record replaced. */
const upsertSubagent = (model: SessionModel, subagent: Subagent): SessionModel =>
  updateTurn(model, subagent.turnId, (view) =>
    view.subagents.some((s) => s.subagent.id === subagent.id)
      ? {
          ...view,
          subagents: view.subagents.map((s) =>
            s.subagent.id === subagent.id ? { ...s, subagent } : s
          ),
        }
      : { ...view, subagents: [...view.subagents, { subagent, items: [], live: noLive }] }
  );

type Fold = (model: SessionModel) => SessionModel;

const same: Fold = (model) => model;

const fold = (event: DomainEvent): Fold =>
  Match.value(event).pipe(
    Match.tagsExhaustive({
      // Constellation events are projected in their own view.
      ConstellationStarted: () => same,
      ConstellationStateChanged: () => same,
      LeadChanged: () => same,
      LeadHandoverRequested: () => same,
      LeadHandoverCancelled: () => same,
      AttemptInterrupted: () => same,
      AttemptStale: () => same,
      AttemptFresh: () => same,
      WorkerInputDelivered: () => same,
      TaskDeclared: () => same,
      TaskEdited: () => same,
      TaskCanceled: () => same,
      TaskProposed: () => same,
      ProposalAccepted: () => same,
      ProposalDeclined: () => same,
      AttemptStarted: () => same,
      AttemptProgressed: () => same,
      ClaimApproved: () => same,
      ClaimHandedUp: () => same,
      AttemptBlocked: () => same,
      AttemptUnblocked: () => same,
      AttemptNudged: () => same,
      AttemptClaimed: () => same,
      AttemptAccepted: () => same,
      AttemptRejected: () => same,
      AttemptSettled: () => same,
      GatePromoted: () => same,
      NotificationQueued: () => same,
      LeadNotified: () => same,
      OperatorMessageSent: () => same,
      OperatorMessageResolved: () => same,
      PeerMessage: () => same,
      AttemptRecoveryContinued: () => same,
      ResourceDeclared: () => same,
      ResourceRemoved: () => same,
      ResourceLeaseCanceled: () => same,
      ResourceLeaseQueued: () => same,
      ResourceLeased: () => same,
      ResourceReleased: () => same,

      WorkspaceRegistered: () => same,
      WorkspaceUpdated: () => same,
      WorkspaceRemoved: () => same,
      WorktreeDetected: () => same,
      WorktreeRemoved: () => same,
      TurnsAccepted:
        ({ throughIndex, throughUserTurn }): Fold =>
        (m) =>
          patchSession(m, {
            acceptedThroughIndex: throughIndex,
            acceptedThroughUserTurn: throughUserTurn,
          }),
      TurnsReverted: () => same,
      SessionPullRequestLinked:
        ({ pullRequest }): Fold =>
        (m) =>
          patchSession(m, { pullRequest }),
      // Review Checkouts, Risk Summaries and Verdicts: the Review UI keeps its own (M2-K, M2-F).
      ReviewCheckoutOpened: () => same,
      ReviewCheckoutChanged: () => same,
      ReviewCheckoutRemoved: () => same,
      RiskSummaryStarted: () => same,
      RiskSummaryLayerChanged: () => same,
      RiskFindingsRecorded: () => same,
      RiskFindingResolved: () => same,
      RiskSummaryEnded: () => same,
      VerdictRecorded: () => same,
      SessionCreated:
        ({ session }): Fold =>
        (m) => ({ ...m, session }),
      SessionStateChanged:
        ({ state, reason, resetsAt }): Fold =>
        (m) =>
          patchSession(m, {
            state,
            lastError: state === "failed" ? reason : (m.session?.lastError ?? null),
            limitResetsAt: state === "limited" ? (resetsAt ?? null) : null,
          }),
      SessionRenamed:
        ({ title }): Fold =>
        (m) =>
          patchSession(m, { title }),
      SessionNotified: () => same,
      SessionBackgroundCommandFailed: () => same,
      SessionPinned:
        ({ pinnedAt }): Fold =>
        (m) =>
          patchSession(m, { pinnedAt }),
      SessionResumeAtResetChanged:
        ({ resumeAtReset }): Fold =>
        (m) =>
          patchSession(m, { resumeAtReset }),
      SessionCursorUpdated:
        ({ harnessCursor }): Fold =>
        (m) =>
          patchSession(m, { harnessCursor }),
      SessionModelChanged:
        ({ model, effort, serviceTier }): Fold =>
        (m) =>
          patchSession(m, {
            model,
            effort,
            serviceTier: serviceTier ?? m.session?.serviceTier ?? null,
          }),
      SessionPermissionModeChanged:
        ({ permissionMode }): Fold =>
        (m) =>
          patchSession(m, { permissionMode }),
      SessionSetupChanged:
        ({ setup }): Fold =>
        (model) =>
          patchSession(model, { worktreeSetup: setup }),
      SessionContextUsed:
        ({ usage }): Fold =>
        (m) =>
          patchSession(m, { contextUsage: usage }),
      SessionCompacted:
        ({ compaction }): Fold =>
        (m) =>
          patchSession(m, { lastCompaction: compaction }),
      SessionBackgroundTasksChanged:
        ({ tasks, reportsPending }): Fold =>
        (m) =>
          patchSession(m, { backgroundTasks: tasks, backgroundReportsPending: reportsPending }),
      TurnStarted:
        ({ turn }): Fold =>
        (m) =>
          patchSession(upsertTurn(m, turn), {
            turnCount: Math.max(m.session?.turnCount ?? 0, turn.index + 1),
          }),
      TurnEnded:
        ({ turn }): Fold =>
        (m) =>
          updateTurn(upsertTurn(m, turn), turn.id, (view) => ({ ...view, live: noLive })),
      TurnItemCompleted:
        ({ turnId, item, subagentId }): Fold =>
        (m) =>
          // A Subagent's own items belong to it, never to the Turn.
          subagentId === null
            ? updateTurn(m, turnId, (view) => completeItem(view, item))
            : updateSubagent(m, turnId, subagentId, (view) => completeItem(view, item)),
      SubagentStarted:
        ({ subagent }): Fold =>
        (m) =>
          upsertSubagent(m, subagent),
      SubagentEnded:
        ({ subagent }): Fold =>
        (m) =>
          updateSubagent(upsertSubagent(m, subagent), subagent.turnId, subagent.id, (view) => ({
            ...view,
            live: noLive,
          })),
      CheckpointRecorded: () => same,
      ApprovalRequested:
        ({ request }): Fold =>
        (m) => ({
          ...m,
          pendingApprovals: [...withoutRequest(m, request.id).pendingApprovals, request],
        }),
      ApprovalResolved:
        ({ requestId, decision, resolvedBy }): Fold =>
        (m) =>
          settle(m, requestId, {
            secret: secretOutcomeOf(decision),
            write: writeOutcomeOf(decision, resolvedBy),
          }),
      ApprovalWithdrawn:
        ({ requestId, withdrawnBy, reason }): Fold =>
        (m) =>
          settle(m, requestId, {
            secret: "ended",
            write: { kind: "expired", by: withdrawnBy, reason },
          }),
    })
  );

const applyEnvelope = (model: SessionModel, envelope: EventEnvelope): SessionModel => {
  if (envelope.sequence <= model.sequence) return model;

  return { ...fold(envelope.event)(model), sequence: envelope.sequence };
};

const liveOf = (view: Holder, itemId: string): LiveItem =>
  view.live.get(itemId) ?? { item: null, text: "", output: "" };

const withLive = <H extends Holder>(view: H, itemId: string, live: LiveItem): H => {
  // A delta can trail its item's completion by a frame; never resurrect it.
  if (view.items.some((i) => i.id === itemId)) return view;

  return { ...view, live: new Map(view.live).set(itemId, live) };
};

/** Applies a change to the Turn, or to its Subagent when the item is the Subagent's own. */
const onHolder = (
  model: SessionModel,
  turnId: string,
  subagentId: string | null,
  change: <H extends Holder>(holder: H) => H
): SessionModel =>
  subagentId === null
    ? updateTurn(model, turnId, (view) => change(view))
    : updateSubagent(model, turnId, subagentId, (view) => change(view));

export const applySessionItem = (model: SessionModel, item: SessionStreamItem): SessionModel =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot): SessionModel => ({
        sequence: snapshot.sequence,
        synchronized: false,
        session: snapshot.session,
        turns: snapshot.turns.map(turnViewOf),
        pendingApprovals: snapshot.pendingApprovals,
        // A resync keeps the cards of secrets and writes settled since this feed opened.
        settledSecrets: model.settledSecrets ?? [],
        settledWrites: model.settledWrites ?? [],
      }),
      Event: ({ envelope }) => applyEnvelope(model, envelope),
      Delta: ({ turnId, itemId, field, text, subagentId }) =>
        onHolder(model, turnId, subagentId, (view) => {
          const live = liveOf(view, itemId);

          return withLive(view, itemId, { ...live, [field]: live[field] + text });
        }),
      ItemProgress: ({ turnId, item: progress, subagentId }) =>
        onHolder(model, turnId, subagentId, (view) =>
          withLive(view, progress.id, { ...liveOf(view, progress.id), item: progress })
        ),
      Synchronized: (): SessionModel => ({ ...model, synchronized: true }),
    })
  );

/**
 * A page of older Turns (`session.turns`) merged in: Turns the model doesn't have yet,
 * their items placed by start. Turns already there keep what the feed gave them.
 */
export const withOlderTurns = (model: SessionModel, page: TurnPage): SessionModel => {
  const known = new Set(model.turns.map((t) => t.turn.id));

  const older = page.turns
    .filter((detail) => !known.has(detail.turn.id))
    .map((detail) => turnViewOf(detail));

  if (older.length === 0) return model;

  return {
    ...model,
    turns: [...older, ...model.turns].sort((a, b) => a.turn.index - b.turn.index),
  };
};

export const applySessionItems = (model: SessionModel, items: ReadonlyArray<SessionStreamItem>) =>
  items.reduce(applySessionItem, model);
