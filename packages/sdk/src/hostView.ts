/**
 * A Host as an Extension sees it: its Workspaces, its Agent Sessions and the
 * approvals waiting on the user, folded from `subscribeHost` the way the
 * Daemon folds its log. A Snapshot resets it.
 */
import {
  type AgentSession,
  type ApprovalRequest,
  type Capability,
  type DomainEvent,
  type HostStreamItem,
  isWorkerSession,
  type Sequence,
  type Turn,
  type Workspace,
} from "@polaris/protocol";
import { Match } from "effect";

/** An Agent Session as plain data: the SDK's views copy and patch it. */
export type Session = { readonly [K in keyof AgentSession]: AgentSession[K] };

export const stateFields = (
  session: Session,
  event: Extract<DomainEvent, { readonly _tag: "SessionStateChanged" }>
): Partial<Session> => ({
  state: event.state,
  lastError: event.state === "failed" ? event.reason : session.lastError,
  limitResetsAt: event.state === "limited" ? (event.resetsAt ?? null) : null,
});

export interface SessionEntry {
  readonly session: Session;
  readonly pendingApprovals: ReadonlyArray<ApprovalRequest>;
  /** The latest Turn's prompt, cut short; null before the first Turn. */
  readonly lastTurnPreview: string | null;
}

export interface HostView {
  readonly hostId: string;
  readonly hostName: string;
  /** False while the SDK reconnects; the rest is as last seen. */
  readonly connected: boolean;
  /** Why the Host can't be shown (`subscribeHosts` only); null otherwise. */
  readonly error: Error | null;
  /** What the Host's Daemon announced in `hello`, e.g. `session.plan-mode`; empty until reached. */
  readonly capabilities: ReadonlyArray<Capability>;
  readonly workspaces: ReadonlyArray<Workspace>;
  /**
   * Most recently updated first; archived sessions are left out, and so are Constellation
   * workers' unless they need you (`AgentSession.worker`): their Lead stands for them.
   */
  readonly sessions: ReadonlyArray<SessionEntry>;
  /** The archived sessions, most recently updated first; workers' left out. */
  readonly archived: ReadonlyArray<SessionEntry>;
  /** Every session's pending approvals, workers' included, oldest first. */
  readonly approvals: ReadonlyArray<ApprovalRequest>;
}

/** The fold's state: maps by id, and the last sequence applied. */
export interface HostState {
  readonly sequence: Sequence;
  readonly synchronized: boolean;
  readonly workspaces: ReadonlyMap<string, Workspace>;
  readonly sessions: ReadonlyMap<string, SessionEntry>;
}

export const emptyHostState: HostState = {
  // SAFETY: sequences start at 1, so 0 precedes every real one.
  sequence: 0 as Sequence,
  synchronized: false,
  workspaces: new Map(),
  sessions: new Map(),
};

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined) => {
  const next = new Map(map);

  if (value === undefined) next.delete(key);
  else next.set(key, value);

  return next;
};

type Fold = (state: HostState, at: string) => HostState;

type SessionChange = (entry: SessionEntry) => SessionEntry;

const onSession =
  (sessionId: string, change: SessionChange): Fold =>
  (state, at) => {
    const entry = state.sessions.get(sessionId);

    if (entry === undefined) return state;
    const next = change(entry);

    return {
      ...state,
      sessions: withEntry(state.sessions, sessionId, {
        ...next,
        session: { ...next.session, updatedAt: at },
      }),
    };
  };

const patch =
  (fields: Partial<Session>): SessionChange =>
  (entry) => ({ ...entry, session: { ...entry.session, ...fields } });

const withoutRequest =
  (requestId: string): SessionChange =>
  (entry) => ({
    ...entry,
    pendingApprovals: entry.pendingApprovals.filter((request) => request.id !== requestId),
  });

const onTurn = (turn: Turn) =>
  onSession(turn.sessionId, (entry) => ({
    ...entry,
    lastTurnPreview: turn.prompt.slice(0, 140),
    session: { ...entry.session, turnCount: Math.max(entry.session.turnCount, turn.index + 1) },
  }));

const unchanged: Fold = (state) => state;

const withWorkspace =
  (workspace: Workspace): Fold =>
  (state) => ({ ...state, workspaces: withEntry(state.workspaces, workspace.id, workspace) });

const fold = (event: DomainEvent): Fold =>
  Match.value(event).pipe(
    Match.tags({
      WorkspaceRegistered: ({ workspace }) => withWorkspace(workspace),
      WorkspaceUpdated: ({ workspace }) => withWorkspace(workspace),
      // A removed Workspace takes its sessions with it (docs/adr/0086).
      WorkspaceRemoved:
        ({ workspaceId }): Fold =>
        (state) => ({
          ...state,
          workspaces: withEntry(state.workspaces, workspaceId, undefined),
          sessions: new Map(
            [...state.sessions].filter(([, entry]) => entry.session.workspaceId !== workspaceId)
          ),
        }),
      SessionCreated:
        ({ session }): Fold =>
        (state) => ({
          ...state,
          sessions: withEntry(state.sessions, session.id, {
            session,
            pendingApprovals: [],
            lastTurnPreview: null,
          }),
        }),
      SessionStateChanged: (event) =>
        onSession(event.sessionId, (entry) => ({
          ...entry,
          session: { ...entry.session, ...stateFields(entry.session, event) },
        })),
      SessionResumeAtResetChanged: ({ sessionId, resumeAtReset }) =>
        onSession(sessionId, patch({ resumeAtReset })),
      SessionRenamed: ({ sessionId, title }) => onSession(sessionId, patch({ title })),
      SessionPermissionModeChanged: ({ sessionId, permissionMode }) =>
        onSession(sessionId, patch({ permissionMode })),
      SessionModelChanged: ({ sessionId, model, effort }) =>
        onSession(sessionId, patch({ model, effort })),
      TurnStarted: ({ turn }) => onTurn(turn),
      TurnEnded: ({ turn }) => onTurn(turn),
      ApprovalRequested: ({ request }) =>
        onSession(request.sessionId, (entry) => ({
          ...entry,
          pendingApprovals: [...withoutRequest(request.id)(entry).pendingApprovals, request],
        })),
      ApprovalResolved: ({ sessionId, requestId }) =>
        onSession(sessionId, withoutRequest(requestId)),
      ApprovalWithdrawn: ({ sessionId, requestId }) =>
        onSession(sessionId, withoutRequest(requestId)),
    }),
    Match.orElse(() => unchanged)
  );

/** Applies one item of the Host's feed. Replayed events (an old sequence) are ignored. */
export const applyHostItem = (state: HostState, item: HostStreamItem): HostState =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot): HostState => ({
        sequence: snapshot.sequence,
        synchronized: false,
        workspaces: new Map(snapshot.workspaces.map((workspace) => [workspace.id, workspace])),
        sessions: new Map(
          snapshot.sessions.map((summary) => [
            summary.session.id,
            {
              session: summary.session,
              pendingApprovals: summary.pendingApprovals,
              lastTurnPreview: summary.lastTurnPreview,
            },
          ])
        ),
      }),
      Event: ({ envelope }) =>
        envelope.sequence <= state.sequence
          ? state
          : { ...fold(envelope.event)(state, envelope.occurredAt), sequence: envelope.sequence },
      Synchronized: ({ sequence }): HostState => ({ ...state, sequence, synchronized: true }),
    })
  );

const needsYou = (entry: SessionEntry) =>
  entry.session.state === "needs-you" || entry.pendingApprovals.length > 0;

export const hostView = (
  state: HostState,
  host: { readonly hostId: string; readonly hostName: string },
  connected: boolean,
  capabilities: ReadonlyArray<Capability> = []
): HostView => {
  const newestFirst = [...state.sessions.values()].sort((a, b) =>
    b.session.updatedAt.localeCompare(a.session.updatedAt)
  );

  const active = newestFirst.filter((entry) => entry.session.state !== "archived");

  return {
    ...host,
    connected,
    error: null,
    capabilities,
    workspaces: [...state.workspaces.values()].filter((workspace) => !workspace.hidden),
    sessions: active.filter((entry) => !isWorkerSession(entry.session) || needsYou(entry)),
    archived: newestFirst.filter(
      (entry) => entry.session.state === "archived" && !isWorkerSession(entry.session)
    ),
    approvals: active
      .flatMap((entry) => entry.pendingApprovals)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt)),
  };
};
