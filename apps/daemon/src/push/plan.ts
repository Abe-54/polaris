/**
 * Which pushes the Host's events call for, as the Desktop App plans its banners: one per new
 * approval or question (Needs You), one per `SessionNotified`, and one when a Turn ends and its
 * session stays Idle with no background tasks for `SETTLE_MS` (docs/adr/0073). A Constellation
 * worker pushes only Needs You: its Lead reports the rest (ENG-586). Pure.
 */
import {
  type AgentSession,
  type ApprovalRequest,
  type DomainEvent,
  harnessEntry,
  type HostStreamItem,
  isWorkerSession,
  type SessionNotification,
  type Turn,
} from "@polaris/protocol";
import type { PushMessage } from "@polaris/protocol/relay";
import { Match } from "effect";

/** How long a settle must hold before a finished Turn is pushed (ADR 0073). */
export const SETTLE_MS = 3_000;

/** The body when a Turn ended without a reply (the Desktop App's `NO_REPLY`). */
export const NO_REPLY = "Ready for the next turn";

interface Tracked {
  readonly title: string;
  readonly harness: string;
  readonly working: boolean;
  readonly backgroundTasks: number;
  /** A Constellation worker's (`AgentSession.worker`): it pushes only Needs You (ENG-586). */
  readonly worker: boolean;
  /** A Turn ended: its index and reply, and when the session settled (null while tasks are live). */
  readonly ended: {
    readonly index: number;
    readonly reply: string | null;
    readonly settledAt: number | null;
  } | null;
}

export interface PlanState {
  readonly synchronized: boolean;
  readonly sessions: ReadonlyMap<string, Tracked>;
  /** Lead Turns Polaris started for a digest (LeadNotified): their ends aren't the user's news. */
  readonly digestTurns: ReadonlySet<string>;
}

export const emptyPlan: PlanState = {
  synchronized: false,
  sessions: new Map(),
  digestTurns: new Set(),
};

export interface PlanContext {
  readonly hostId: string;
  readonly hostName: string;
  readonly now: number;
}

/** What a push asks of the user: a Needs You is held at a Desktop App until answered (`hold.ts`). */
export interface Need {
  readonly sessionId: string;
  /** Needs You: handled once this request is answered or withdrawn. */
  readonly requestId: string | null;
}

/** A push, and whether it is automatic: devices that turned those off don't get it. */
export interface Push {
  readonly message: PushMessage;
  readonly automatic: boolean;
  readonly need: Need;
}

export interface Planned {
  readonly state: PlanState;
  readonly send: ReadonlyArray<Push>;
}

const push = (message: PushMessage, need: Need): Push => ({ message, automatic: false, need });

const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const harnessName = (kind: string) => harnessEntry(kind)?.name ?? kind;

const tracked = (session: AgentSession): Tracked => ({
  title: session.title,
  harness: harnessName(session.harness),
  working: session.state === "working",
  backgroundTasks: session.backgroundTasks.length,
  worker: isWorkerSession(session),
  ended: null,
});

const categoryOf = (request: ApprovalRequest) =>
  request.kind === "question" || request.kind === "secret"
    ? "question"
    : request.profileAttach === undefined
      ? "approval"
      : "approval-once";

const needsYou = (
  session: Tracked,
  request: ApprovalRequest,
  context: PlanContext
): PushMessage => ({
  v: 1,
  kind: "needs-you",
  hostId: context.hostId,
  hostName: context.hostName,
  sessionId: request.sessionId,
  requestId: request.id,
  // A secret is typed in the app: `question` has no actions and opens it.
  category: categoryOf(request),
  title: cut(
    request.kind === "secret"
      ? `${session.harness} is asking for a secret`
      : `${session.harness} needs you`,
    120
  ),
  subtitle: cut(`${context.hostName} · ${session.title}`, 160),
  // A Secret Request's reason may describe infrastructure; only its label leaves the Host.
  body: cut(
    request.kind === "secret" || request.detail === null || request.detail === request.title
      ? request.title
      : `${request.title}\n${request.detail}`,
    600
  ),
  at: new Date(context.now).toISOString(),
});

const turnEnded = (
  sessionId: string,
  session: Tracked,
  reply: string | null,
  context: PlanContext
): PushMessage => ({
  v: 1,
  kind: "turn-ended",
  hostId: context.hostId,
  hostName: context.hostName,
  sessionId,
  requestId: null,
  category: null,
  title: cut(`${session.harness} finished a turn`, 120),
  subtitle: cut(`${context.hostName} · ${session.title}`, 160),
  body: cut(reply ?? NO_REPLY, 600),
  at: new Date(context.now).toISOString(),
});

const notified = (
  sessionId: string,
  session: Tracked,
  notification: SessionNotification,
  context: PlanContext
): Push => ({
  automatic: notification.automatic,
  need: { sessionId, requestId: null },
  message: {
    v: 1,
    kind: "notify",
    hostId: context.hostId,
    hostName: context.hostName,
    sessionId,
    requestId: null,
    category: null,
    title: cut(notification.title, 120),
    subtitle: cut(`${context.hostName} · ${session.title}`, 160),
    body: cut(notification.body, 600),
    at: notification.at,
    constellationId: notification.constellationId,
  },
});

type Change = (session: Tracked, now: number) => Tracked;

const update = (state: PlanState, sessionId: string, change: Change, now: number): PlanState => {
  const session = state.sessions.get(sessionId);

  if (session === undefined) return state;
  const sessions = new Map(state.sessions);
  sessions.set(sessionId, change(session, now));

  return { ...state, sessions };
};

const withTasks =
  (count: number): Change =>
  (session, now) => ({
    ...session,
    backgroundTasks: count,
    // The last task finishing is when an ended Turn starts to settle.
    ended:
      session.ended === null
        ? null
        : { ...session.ended, settledAt: count === 0 ? (session.ended.settledAt ?? now) : null },
  });

/** A Turn ended; a digest's, a worker's or an idle compaction's ends quietly (the Desktop App's `turnsOf`). */
const endTurn = (state: PlanState, turn: Turn, now: number): PlanState => {
  const quiet =
    state.digestTurns.has(turn.id) ||
    state.sessions.get(turn.sessionId)?.worker === true ||
    turn.idleCompaction === true;

  const digestTurns = new Set(state.digestTurns);
  digestTurns.delete(turn.id);

  return update(
    { ...state, digestTurns },
    turn.sessionId,
    (s) => ({
      ...s,
      working: false,
      ended: quiet
        ? null
        : {
            index: turn.index,
            reply: turn.replyPreview ?? null,
            settledAt: s.backgroundTasks === 0 ? now : null,
          },
    }),
    now
  );
};

const applyEvent = (state: PlanState, event: DomainEvent, context: PlanContext): Planned => {
  const now = context.now;
  const same = (next: PlanState): Planned => ({ state: next, send: [] });

  return Match.value(event).pipe(
    Match.tags({
      SessionCreated: ({ session }) => {
        const sessions = new Map(state.sessions);
        sessions.set(session.id, tracked(session));

        return same({ ...state, sessions });
      },
      SessionRenamed: ({ sessionId, title }) =>
        same(update(state, sessionId, (s) => ({ ...s, title }), now)),
      SessionBackgroundTasksChanged: ({ sessionId, tasks }) =>
        same(update(state, sessionId, withTasks(tasks.length), now)),
      TurnStarted: ({ turn }) =>
        same(update(state, turn.sessionId, (s) => ({ ...s, working: true, ended: null }), now)),
      TurnEnded: ({ turn }) => same(endTurn(state, turn, now)),
      ApprovalRequested: ({ request }): Planned => {
        const session = state.sessions.get(request.sessionId);

        return {
          state,
          send:
            session === undefined || !state.synchronized
              ? []
              : [
                  push(needsYou(session, request, context), {
                    sessionId: request.sessionId,
                    requestId: request.id,
                  }),
                ],
        };
      },
      SessionNotified: ({ sessionId, notification }): Planned => {
        const session = state.sessions.get(sessionId);

        return {
          state,
          send:
            session === undefined || session.worker || !state.synchronized
              ? []
              : [notified(sessionId, session, notification, context)],
        };
      },
      LeadNotified: ({ turnId, steered }) =>
        same(steered ? state : { ...state, digestTurns: new Set(state.digestTurns).add(turnId) }),
      AttemptStarted: ({ attempt }) =>
        same(update(state, attempt.sessionId, (s) => ({ ...s, worker: true }), now)),
    }),
    Match.orElse(() => same(state))
  );
};

/** Applies one Host stream item. Only items after `Synchronized` push anything. */
export const planItem = (state: PlanState, item: HostStreamItem, context: PlanContext): Planned =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot): Planned => ({
        state: {
          ...state,
          synchronized: false,
          sessions: new Map(snapshot.sessions.map((s) => [s.session.id, tracked(s.session)])),
        },
        send: [],
      }),
      Synchronized: (): Planned => ({ state: { ...state, synchronized: true }, send: [] }),
      Event: ({ envelope }) => applyEvent(state, envelope.event, context),
    })
  );

/** Pushes the finished Turns whose settle held for `SETTLE_MS` by `context.now`. */
export const planSettled = (state: PlanState, context: PlanContext): Planned => {
  const send: Array<Push> = [];
  const sessions = new Map(state.sessions);

  for (const [sessionId, session] of state.sessions) {
    const settledAt = session.ended?.settledAt ?? null;

    if (session.ended === null || settledAt === null || session.working) continue;

    if (context.now - settledAt < SETTLE_MS) continue;
    sessions.set(sessionId, { ...session, ended: null });

    if (state.synchronized)
      send.push(
        push(turnEnded(sessionId, session, session.ended.reply, context), {
          sessionId,
          requestId: null,
        })
      );
  }

  return { state: { ...state, sessions }, send };
};

/** When to call `planSettled` next: the earliest pending settle's end, or null. */
export const nextSettle = (state: PlanState): number | null => {
  let next: number | null = null;

  for (const session of state.sessions.values()) {
    const settledAt = session.ended?.settledAt ?? null;

    if (settledAt !== null && !session.working)
      next = next === null ? settledAt + SETTLE_MS : Math.min(next, settledAt + SETTLE_MS);
  }

  return next;
};
