/**
 * The SQL side of the store: JSON codecs for what it persists, the `events`
 * row of an envelope, the projection tables an envelope changes, and loading
 * the read model back from those tables on start.
 */
import {
  AgentSession,
  ApprovalRequest,
  CommandId,
  CommandRejected,
  ConstellationRejected,
  DomainEvent,
  EventEnvelope,
  NotFound,
  NotGranted,
  RequestId,
  ReviewCheckout,
  Sequence,
  type SessionId,
  Subagent,
  Turn,
  type TurnId,
  TurnItem,
  Workspace,
  type WorkspaceId,
  Worktree,
} from "@polaris/protocol";
import { Effect, Predicate, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { emptyResources, foldResources } from "../resources/model.ts";
import { constellationOf } from "./constellation.ts";
import { project } from "./model.ts";
import { withoutConstellationsOf } from "./removal.ts";
import { replyText } from "./userTurns.ts";
import { storeError } from "./errors.ts";
import { projectReviewEvent } from "./review.ts";
import { json } from "./json.ts";
import { EventJson } from "./eventJson.ts";
import {
  emptyModel,
  RECENT_TURNS,
  type ReadModel,
  type SessionRecord,
  sessionOf,
} from "./model.ts";

// ── Codecs ──────────────────────────────────────────────────────────────────

export { EventJson };

export const WorkspaceJson = json(Workspace);

export const WorktreeJson = json(Worktree);

export const SessionJson = json(AgentSession);

export const TurnJson = json(Turn);

export const TurnItemJson = json(TurnItem);

export const ApprovalJson = json(ApprovalRequest);

export const SubagentJson = json(Subagent);

export const ReviewCheckoutJson = json(ReviewCheckout);

export const RejectionJson = json(
  Schema.Union([CommandRejected, NotFound, NotGranted, ConstellationRejected])
);

export { storeError };

// ── Events ──────────────────────────────────────────────────────────────────

export interface EventRow {
  readonly sequence: number;
  readonly occurred_at: string;
  readonly command_id: string | null;
  readonly payload: string;
}

export const decodeEventRow = (row: EventRow): EventEnvelope =>
  new EventEnvelope({
    sequence: Sequence.make(row.sequence),
    occurredAt: row.occurred_at,
    commandId: row.command_id === null ? null : CommandId.make(row.command_id),
    event: EventJson.decode(row.payload),
  });

export const writeEvent = (sql: SqlClient.SqlClient, envelope: EventEnvelope) => {
  const sessionId = sessionOf(envelope.event);

  return sql`INSERT INTO events ${sql.insert({
    sequence: envelope.sequence,
    stream_kind: sessionId === null ? "host" : "session",
    session_id: sessionId,
    constellation_id: constellationOf(envelope.event),
    event_type: envelope.event._tag,
    command_id: envelope.commandId,
    occurred_at: envelope.occurredAt,
    payload: EventJson.encode(envelope.event),
  })}`;
};

// ── Projections ─────────────────────────────────────────────────────────────

type SqlWrite = Effect.Effect<unknown, SqlError.SqlError>;

/** An envelope being projected, the model after it, and the database. */
interface Projecting {
  readonly sql: SqlClient.SqlClient;
  readonly after: ReadModel;
  readonly envelope: EventEnvelope;
}

type Projection = (target: Projecting) => SqlWrite;

/** The session-keyed tables a removed Workspace's sessions leave, children before `sessions`. */
const SESSION_TABLES = [
  "turn_items",
  "turns",
  "pending_approvals",
  "subagents",
  "session_reads",
  "session_drafts",
] as const;

/** `WorkspaceRemoved`: every projection row of the Workspace and its sessions (`removal.ts`). */
const purgeWorkspaceRows = (sql: SqlClient.SqlClient, workspaceId: WorkspaceId) =>
  Effect.all(
    [
      ...SESSION_TABLES.map(
        (table) =>
          sql`DELETE FROM ${sql(table)} WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = ${workspaceId})`
      ),
      sql`DELETE FROM sessions WHERE workspace_id = ${workspaceId}`,
      sql`DELETE FROM worktrees WHERE workspace_id = ${workspaceId}`,
      sql`DELETE FROM workspaces WHERE id = ${workspaceId}`,
    ],
    { discard: true }
  );

const upsertSession = (sql: SqlClient.SqlClient, record: SessionRecord | undefined) =>
  record === undefined
    ? Effect.void
    : sql`INSERT OR REPLACE INTO sessions ${sql.insert({
        id: record.session.id,
        workspace_id: record.session.workspaceId,
        state: record.session.state,
        title_locked: record.titleLocked ? 1 : 0,
        data: SessionJson.encode(record.session),
      })}`;

const upsertTurn = (sql: SqlClient.SqlClient, turn: Turn | undefined) =>
  turn === undefined
    ? Effect.void
    : sql`INSERT OR REPLACE INTO turns ${sql.insert({
        id: turn.id,
        session_id: turn.sessionId,
        turn_index: turn.index,
        status: turn.status,
        data: TurnJson.encode(turn),
      })}`;

/** Every session event rewrites its session's row; `also` is what else it changes. */
const sessionRow =
  (sessionId: SessionId, also?: (target: Projecting) => SqlWrite): Projection =>
  (target) => {
    const session = upsertSession(target.sql, target.after.sessions.get(sessionId));

    return also === undefined ? session : Effect.all([session, also(target)]);
  };

const setWorkspace = ({ sql }: Projecting, workspace: Workspace) =>
  sql`INSERT OR REPLACE INTO workspaces ${sql.insert({
    id: workspace.id,
    path: workspace.path,
    data: WorkspaceJson.encode(workspace),
  })}`;

const turnIn = (model: ReadModel, sessionId: SessionId, turnId: TurnId) =>
  model.sessions.get(sessionId)?.turns.find((t) => t.id === turnId);

/** The Turn as the fold keeps it, with its derived user-Turn number and reply preview. */
const turnRow = (turn: Turn) =>
  sessionRow(turn.sessionId, ({ sql, after }) =>
    upsertTurn(sql, turnIn(after, turn.sessionId, turn.id) ?? turn)
  );

const withdrawnRequest = (event: {
  readonly sessionId: SessionId;
  readonly requestId: RequestId;
}) =>
  sessionRow(
    event.sessionId,
    ({ sql }) => sql`DELETE FROM pending_approvals WHERE request_id = ${event.requestId}`
  );

const subagentRow = (subagent: Subagent) =>
  sessionRow(
    subagent.sessionId,
    ({ sql }) =>
      sql`INSERT OR REPLACE INTO subagents ${sql.insert({
        id: subagent.id,
        session_id: subagent.sessionId,
        turn_id: subagent.turnId,
        status: subagent.status,
        data: SubagentJson.encode(subagent),
      })}`
  );

const checkoutRow =
  (checkout: ReviewCheckout): Projection =>
  ({ sql }) =>
    sql`INSERT OR REPLACE INTO review_checkouts ${sql.insert({
      id: checkout.id,
      workspace_id: checkout.workspaceId,
      data: ReviewCheckoutJson.encode(checkout),
    })}`;

const reviewRow =
  (event: DomainEvent): Projection =>
  ({ sql, envelope }) =>
    projectReviewEvent(sql, event, envelope.sequence, envelope.occurredAt);

const projectionOf: (event: DomainEvent) => Projection = DomainEvent.match<Projection>({
  // Graph and lease events persist in the log; they do not change session tables.
  ConstellationStarted: () => () => Effect.void,
  ConstellationStateChanged: () => () => Effect.void,
  LeadChanged: () => () => Effect.void,
  LeadHandoverRequested: () => () => Effect.void,
  LeadHandoverCancelled: () => () => Effect.void,
  AttemptInterrupted: () => () => Effect.void,
  AttemptStale: () => () => Effect.void,
  AttemptFresh: () => () => Effect.void,
  WorkerInputDelivered: () => () => Effect.void,
  TaskDeclared: () => () => Effect.void,
  TaskEdited: () => () => Effect.void,
  TaskCanceled: () => () => Effect.void,
  TaskProposed: () => () => Effect.void,
  ProposalAccepted: () => () => Effect.void,
  ProposalDeclined: () => () => Effect.void,
  AttemptStarted: () => () => Effect.void,
  AttemptProgressed: () => () => Effect.void,
  ClaimApproved: () => () => Effect.void,
  ClaimHandedUp: () => () => Effect.void,
  AttemptBlocked: () => () => Effect.void,
  AttemptUnblocked: () => () => Effect.void,
  AttemptNudged: () => () => Effect.void,
  AttemptClaimed: () => () => Effect.void,
  AttemptAccepted: () => () => Effect.void,
  AttemptRejected: () => () => Effect.void,
  AttemptSettled: () => () => Effect.void,
  GatePromoted: () => () => Effect.void,
  NotificationQueued: () => () => Effect.void,
  LeadNotified: () => () => Effect.void,
  OperatorMessageSent: () => () => Effect.void,
  OperatorMessageResolved: () => () => Effect.void,
  PeerMessage: () => () => Effect.void,
  AttemptRecoveryContinued: () => () => Effect.void,
  ResourceDeclared: () => () => Effect.void,
  ResourceRemoved: () => () => Effect.void,
  ResourceLeaseCanceled: () => () => Effect.void,
  ResourceLeaseQueued: () => () => Effect.void,
  ResourceLeased: () => () => Effect.void,
  ResourceReleased: () => () => Effect.void,

  WorkspaceRegistered: (event) => (target) => setWorkspace(target, event.workspace),
  WorkspaceUpdated: (event) => (target) => setWorkspace(target, event.workspace),
  WorkspaceRemoved:
    ({ workspaceId }) =>
    ({ sql }) =>
      purgeWorkspaceRows(sql, workspaceId),
  WorktreeDetected:
    ({ worktree }) =>
    ({ sql }) =>
      sql`INSERT OR REPLACE INTO worktrees ${sql.insert({
        id: worktree.id,
        workspace_id: worktree.workspaceId,
        data: WorktreeJson.encode(worktree),
      })}`,
  WorktreeRemoved:
    ({ worktreeId }) =>
    ({ sql }) =>
      sql`DELETE FROM worktrees WHERE id = ${worktreeId}`,
  SessionCreated: (event) => sessionRow(event.session.id),
  SessionStateChanged: (event) => sessionRow(event.sessionId),
  SessionRenamed: (event) => sessionRow(event.sessionId),
  SessionPinned: (event) => sessionRow(event.sessionId),
  SessionResumeAtResetChanged: (event) => sessionRow(event.sessionId),
  SessionCursorUpdated: (event) => sessionRow(event.sessionId),
  SessionPermissionModeChanged: (event) => sessionRow(event.sessionId),
  SessionModelChanged: (event) => sessionRow(event.sessionId),
  SessionSetupChanged: (event) => sessionRow(event.sessionId),
  SessionContextUsed: (event) => sessionRow(event.sessionId),
  SessionCompacted: (event) => sessionRow(event.sessionId),
  SessionReplySuggested: (event) => sessionRow(event.sessionId),
  SessionBackgroundTasksChanged: (event) => sessionRow(event.sessionId),
  SessionNotified: () => () => Effect.void,
  SessionBackgroundCommandFailed: () => () => Effect.void,
  TurnStarted: ({ turn }) => turnRow(turn),
  TurnEnded: ({ turn }) => turnRow(turn),
  CheckpointRecorded: (event) =>
    sessionRow(event.sessionId, ({ sql, after }) =>
      upsertTurn(sql, turnIn(after, event.sessionId, event.turnId))
    ),
  TurnItemCompleted: (event) =>
    sessionRow(event.sessionId, ({ sql, envelope, after }) => {
      const item = sql`INSERT INTO turn_items ${sql.insert({
        sequence: envelope.sequence,
        session_id: event.sessionId,
        turn_id: event.turnId,
        item_id: event.item.id,
        subagent_id: event.subagentId,
        data: TurnItemJson.encode(event.item),
      })}`;

      // A reply sets its Turn's preview (`recordReply` in model.ts).
      return replyText(event) === null
        ? item
        : Effect.all([item, upsertTurn(sql, turnIn(after, event.sessionId, event.turnId))]);
    }),
  ApprovalRequested: ({ request }) =>
    sessionRow(
      request.sessionId,
      ({ sql }) =>
        sql`INSERT OR REPLACE INTO pending_approvals ${sql.insert({
          request_id: request.id,
          session_id: request.sessionId,
          data: ApprovalJson.encode(request),
        })}`
    ),
  ApprovalResolved: withdrawnRequest,
  ApprovalWithdrawn: withdrawnRequest,
  SubagentStarted: ({ subagent }) => subagentRow(subagent),
  SubagentEnded: ({ subagent }) => subagentRow(subagent),
  TurnsAccepted: (event) => sessionRow(event.sessionId),
  TurnsReverted: (event) => sessionRow(event.sessionId),
  SessionPullRequestLinked: (event) => sessionRow(event.sessionId),
  ReviewCheckoutOpened: ({ checkout }) => checkoutRow(checkout),
  ReviewCheckoutChanged: ({ checkout }) => checkoutRow(checkout),
  ReviewCheckoutRemoved:
    ({ checkoutId }) =>
    ({ sql }) =>
      sql`DELETE FROM review_checkouts WHERE id = ${checkoutId}`,
  RiskSummaryStarted: reviewRow,
  RiskSummaryLayerChanged: reviewRow,
  RiskFindingsRecorded: reviewRow,
  RiskFindingResolved: reviewRow,
  RiskSummaryEnded: reviewRow,
  VerdictRecorded: reviewRow,
});

/** Persist what `envelope` changed in the read model `after` it. */
export const writeProjection = (
  sql: SqlClient.SqlClient,
  after: ReadModel,
  envelope: EventEnvelope
): SqlWrite => projectionOf(envelope.event)({ sql, after, envelope });

// ── Loading ─────────────────────────────────────────────────────────────────

const byId = <A extends { readonly id: K }, K>(items: ReadonlyArray<A>) =>
  new Map(items.map((item) => [item.id, item]));

/** A Constellation event, or a removal that drops the removed Workspace's Constellations. */
const foldGraphRow = (model: ReadModel, envelope: EventEnvelope): ReadModel =>
  Predicate.isTagged(envelope.event, "WorkspaceRemoved")
    ? {
        ...model,
        constellations: withoutConstellationsOf(model.constellations, envelope.event.workspaceId),
      }
    : project(model, envelope);

export const loadModel = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const [max] = yield* sql<{
      sequence: number | null;
    }>`SELECT MAX(sequence) AS sequence FROM events`;

    const workspaces = yield* sql<{ data: string }>`SELECT data FROM workspaces`;
    const worktrees = yield* sql<{ data: string }>`SELECT data FROM worktrees`;

    const sessions = yield* sql<{ data: string; title_locked: number }>`
      SELECT data, title_locked FROM sessions`;

    // Only the most recent Turns of each session stay in memory (see RECENT_TURNS).
    const turns = yield* sql<{ data: string }>`
      SELECT data FROM (
        SELECT data, session_id, turn_index,
          ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY turn_index DESC) AS recency
        FROM turns
      ) WHERE recency <= ${RECENT_TURNS}
      ORDER BY session_id, turn_index`;

    const pending = yield* sql<{ data: string }>`SELECT data FROM pending_approvals`;
    const checkouts = yield* sql<{ data: string }>`SELECT data FROM review_checkouts`;

    const working = yield* sql<{
      data: string;
    }>`SELECT data FROM subagents WHERE status = 'working'`;

    const turnsBySession = new Map<string, Array<Turn>>();

    for (const row of turns) {
      const turn = TurnJson.decode(row.data);
      const list = turnsBySession.get(turn.sessionId) ?? [];
      list.push(turn);
      turnsBySession.set(turn.sessionId, list);
    }

    const pendingBySession = new Map<string, Map<RequestId, ApprovalRequest>>();

    for (const row of pending) {
      const request = ApprovalJson.decode(row.data);
      const map = pendingBySession.get(request.sessionId) ?? new Map<RequestId, ApprovalRequest>();
      map.set(request.id, request);
      pendingBySession.set(request.sessionId, map);
    }

    const subagentsBySession = new Map<string, Map<Subagent["id"], Subagent>>();

    for (const row of working) {
      const subagent = SubagentJson.decode(row.data);
      const map = subagentsBySession.get(subagent.sessionId) ?? new Map<Subagent["id"], Subagent>();
      map.set(subagent.id, subagent);
      subagentsBySession.set(subagent.sessionId, map);
    }

    const records = sessions.map((row): SessionRecord => {
      const session = SessionJson.decode(row.data);

      return {
        session,
        titleLocked: row.title_locked === 1,
        turns: turnsBySession.get(session.id) ?? [],
        pending: pendingBySession.get(session.id) ?? new Map(),
        subagents: subagentsBySession.get(session.id) ?? new Map(),
      };
    });

    const resourceRows = yield* sql<EventRow>`
      SELECT sequence, occurred_at, command_id, payload FROM events
      WHERE event_type IN ('ResourceDeclared', 'ResourceRemoved', 'ResourceLeaseCanceled',
        'ResourceLeaseQueued', 'ResourceLeased', 'ResourceReleased') ORDER BY sequence`;

    let model: ReadModel = {
      ...emptyModel,
      sequence: max?.sequence ?? 0,
      hostResources: foldResources(
        emptyResources(),
        resourceRows.map((row) => decodeEventRow(row))
      ),
      workspaces: byId(workspaces.map((row) => WorkspaceJson.decode(row.data))),
      worktrees: byId(worktrees.map((row) => WorktreeJson.decode(row.data))),
      sessions: new Map(records.map((record) => [record.session.id, record])),
      reviewCheckouts: byId(checkouts.map((row) => ReviewCheckoutJson.decode(row.data))),
    };

    // Constellations fold from the log; a later WorkspaceRemoved drops them again.
    const graphEvents =
      yield* sql<EventRow>`SELECT sequence, occurred_at, command_id, payload FROM events WHERE constellation_id IS NOT NULL OR event_type = 'WorkspaceRemoved' ORDER BY sequence`;

    const cut = model.sequence;

    for (const row of graphEvents) model = foldGraphRow(model, decodeEventRow(row));

    return { ...model, sequence: cut };
  });
