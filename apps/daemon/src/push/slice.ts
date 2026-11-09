/**
 * Folds the Host stream into this Host's Live Activity slice (docs/adr/0088): how many of the
 * user's agent sessions are working and since when, the newest tool step, and the oldest open
 * approval or question. Reviewer and walkthrough sessions are the Daemon's own and don't count. Pure.
 */
import {
  type AgentSession,
  type ApprovalRequest,
  CELESTIAL_PLANETS,
  type DomainEvent,
  harnessEntry,
  type HostStreamItem,
  type TurnItem,
} from "@polaris/protocol";
import {
  commandLine,
  type HostSlice,
  type LiveLine,
  type LiveNeed,
  MAX_LIVE_CELESTIALS,
} from "@polaris/protocol/relay";
import { Match } from "effect";

interface Tracked {
  readonly title: string;
  /** The Harness kind, for the celestial's hue. */
  readonly harness: string;
  readonly body: string;
  /** Its working directory: a command's leading `cd` into it is dropped from the takeover. */
  readonly cwd: string;
  /** Unix seconds its working Turn started; null while it isn't working. */
  readonly since: number | null;
}

/** A step or need before the session's title and Harness are filled in at render. */
type Line = Omit<LiveLine, "session" | "harness">;

type Need = Omit<LiveNeed, "session" | "harness">;

export interface SliceState {
  readonly synchronized: boolean;
  readonly sessions: ReadonlyMap<string, Tracked>;
  readonly step: Line | null;
  readonly needs: ReadonlyMap<string, Need>;
}

export const emptySlice: SliceState = {
  synchronized: false,
  sessions: new Map(),
  step: null,
  needs: new Map(),
};

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const isUsers = (session: AgentSession) => session.origin === null || session.origin === undefined;

const tracked = (session: AgentSession): Tracked => ({
  title: session.title,
  harness: session.harness,
  body: session.celestial ?? CELESTIAL_PLANETS[0],
  cwd: session.cwd,
  since:
    session.state === "working"
      ? seconds(session.currentUserTurn?.startedAt ?? session.updatedAt)
      : null,
});

const needOf = (request: ApprovalRequest, cwd: string): Need => ({
  at: seconds(request.openedAt),
  sessionId: request.sessionId,
  line: request.kind === "command" ? commandLine(request.title, [cwd]) : request.title,
  requestId: request.id,
  // A secret is typed in the app, which the question takeover opens.
  kind:
    request.kind === "question" || request.kind === "secret" || request.profileAttach !== undefined
      ? "question"
      : "approval",
});

/** A tool step's one line, or null for items that aren't tool steps. */
export const stepLine = (item: TurnItem): string | null =>
  Match.value(item).pipe(
    Match.tags({
      CommandExecution: ({ command }) => command,
      FileChange: ({ changes }) =>
        changes.length === 1 ? `Edit ${changes[0]?.path ?? ""}` : `Edit ${changes.length} files`,
      ToolCall: ({ title, name }) => title ?? name,
    }),
    Match.orElse(() => null)
  );

const withSession = (state: SliceState, sessionId: string, change: (s: Tracked) => Tracked) => {
  const session = state.sessions.get(sessionId);

  if (session === undefined) return state;
  const sessions = new Map(state.sessions);
  sessions.set(sessionId, change(session));

  return { ...state, sessions };
};

const withNeeds = (state: SliceState, change: (needs: Map<string, Need>) => void): SliceState => {
  const needs = new Map(state.needs);
  change(needs);

  return { ...state, needs };
};

const applyEvent = (state: SliceState, event: DomainEvent, occurredAt: string): SliceState =>
  Match.value(event).pipe(
    Match.tags({
      SessionCreated: ({ session }) => {
        if (!isUsers(session)) return state;
        const sessions = new Map(state.sessions);
        sessions.set(session.id, tracked(session));

        return { ...state, sessions };
      },
      SessionRenamed: ({ sessionId, title }) =>
        withSession(state, sessionId, (s) => ({ ...s, title })),
      TurnStarted: ({ turn }) =>
        withSession(state, turn.sessionId, (s) => ({ ...s, since: seconds(turn.startedAt) })),
      TurnEnded: ({ turn }) => withSession(state, turn.sessionId, (s) => ({ ...s, since: null })),
      SessionStateChanged: ({ sessionId, state: next }) =>
        withSession(state, sessionId, (s) => ({
          ...s,
          since: next === "working" ? (s.since ?? seconds(occurredAt)) : null,
        })),
      TurnItemCompleted: ({ sessionId, item }) => {
        const line = stepLine(item);

        return line === null || !state.sessions.has(sessionId)
          ? state
          : { ...state, step: { at: seconds(occurredAt), sessionId, line } };
      },
      ApprovalRequested: ({ request }) => {
        const session = state.sessions.get(request.sessionId);

        return session === undefined
          ? state
          : withNeeds(state, (needs) => needs.set(request.id, needOf(request, session.cwd)));
      },
      ApprovalResolved: ({ requestId }) => withNeeds(state, (needs) => needs.delete(requestId)),
      ApprovalWithdrawn: ({ requestId }) => withNeeds(state, (needs) => needs.delete(requestId)),
    }),
    Match.orElse(() => state)
  );

export const sliceItem = (state: SliceState, item: HostStreamItem): SliceState =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: (snapshot): SliceState => {
        const users = snapshot.sessions.filter((summary) => isUsers(summary.session));

        return {
          synchronized: false,
          sessions: new Map(users.map((s) => [s.session.id, tracked(s.session)])),
          step: null,
          needs: new Map(
            users.flatMap((s) =>
              s.pendingApprovals.map((r) => [r.id, needOf(r, s.session.cwd)] as const)
            )
          ),
        };
      },
      Synchronized: (): SliceState => ({ ...state, synchronized: true }),
      Event: ({ envelope }) => applyEvent(state, envelope.event, envelope.occurredAt),
    })
  );

/** The slice without `seq`, which the notifier sets as it sends. */
export type SliceContent = Omit<HostSlice, "seq">;

export const renderSlice = (
  state: SliceState,
  host: { readonly hostId: string; readonly hostName: string }
): SliceContent => {
  const title = (sessionId: string) => state.sessions.get(sessionId)?.title ?? "";

  // The push title's name ("Claude Code"); omitted for a session this fold doesn't know.
  const named = <L extends { readonly sessionId: string }>(line: L) => {
    const kind = state.sessions.get(line.sessionId)?.harness;

    const out: L & { session: string; harness?: string } = {
      ...line,
      session: title(line.sessionId),
    };

    if (kind !== undefined) out.harness = harnessEntry(kind)?.name ?? kind;

    return out;
  };

  const working = [...state.sessions.values()].flatMap((s) =>
    s.since === null ? [] : [{ ...s, since: s.since }]
  );

  const starts = working.map((s) => s.since);
  const oldest = [...state.needs.values()].sort((a, b) => a.at - b.at)[0];

  return {
    v: 1,
    hostId: host.hostId,
    host: host.hostName,
    working: starts.length,
    since: starts.length === 0 ? null : Math.min(...starts),
    step: state.step === null ? null : named(state.step),
    need: oldest === undefined ? null : named(oldest),
    needs: state.needs.size,
    celestials: working
      .sort((a, b) => b.since - a.since)
      .slice(0, MAX_LIVE_CELESTIALS)
      .map(({ body, harness }) => `${harness}/${body}`),
  };
};

/** Whether `state` has a request `sent` didn't: a Needs You goes out at once, with an alert. */
export const opensNeed = (sent: ReadonlySet<string>, state: SliceState): boolean =>
  [...state.needs.keys()].some((id) => !sent.has(id));
