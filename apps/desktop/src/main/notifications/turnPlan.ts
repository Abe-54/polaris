/**
 * Which Turn-ended notifications to show (Settings → Sessions, off by default): one when the
 * user's Turn completes, that is when its session has stayed Idle with no background tasks
 * left for `SETTLE_MS`, never for the session the focused window shows. Turns the Harness
 * starts when background tasks report continue the user's Turn, so they never notify again.
 * With a minimum duration set, only Turns longer than it notify, timed from the user's prompt
 * to completion on the Host's clock. A Lead Turn Polaris started for a digest shows nothing.
 * A Reviewer's or walkthrough's run notifies as its Review, whatever its length. Pure.
 */
import type { NeedsYouSummary, NeedsYouTurn, ReviewTarget } from "../../shared/needsYou.ts";
import { notificationKey } from "./plan.ts";
import { type TurnContent, turnContent } from "./turnContent.ts";

/** Working, Idle with background tasks live or their reports pending, or Idle with neither. */
export type TurnPhase = "working" | "waiting" | "settled";

/** How long a settle must hold before it counts (docs/adr/0073-turn-notifications-wait-out-a-settle.md). */
export const SETTLE_MS = 3_000;

/** One session's user Turn as the planner follows it. */
export interface TurnTrack {
  readonly phase: TurnPhase;
  /** The user Turn's id; null when unknown (a snapshot from a Daemon without user Turns). */
  readonly userTurnId: string | null;
  /** When the user Turn started, or when it was first seen under way if unknown (Host clock). */
  readonly startedAt: string | null;
  /** Its completion was decided (shown or held back): a continuation never notifies again. */
  readonly done: boolean;
  /** When this Client first saw it settled (ms, its own clock), while that settle may not hold. */
  readonly settledAt: number | null;
}

/** Session key → its user Turn at the last summary. */
export type TurnState = ReadonlyMap<string, TurnTrack>;

export const emptyTurnState: TurnState = new Map();

export interface TurnNotification extends TurnContent {
  readonly key: string;
  readonly turn: NeedsYouTurn;
}

export interface TurnPlan {
  readonly show: ReadonlyArray<TurnNotification>;
  readonly close: ReadonlyArray<string>;
  readonly state: TurnState;
  /** Plan again with the same summary after this long: a settle is waiting out `SETTLE_MS`. */
  readonly recheckInMs: number | null;
}

export interface TurnPlanInput {
  readonly state: TurnState;
  readonly summary: NeedsYouSummary;
  readonly windowFocused: boolean;
  /** Only Turns longer than this notify; null or absent for every Turn. */
  readonly minDurationMs?: number | null;
  /** This Client's clock (ms), for `SETTLE_MS`. */
  readonly now: number;
}

/** Its own key space, so a Needs You banner for the same session never replaces it. */
export const turnKey = (hostKey: string, sessionId: string) =>
  `turn\u0000${notificationKey(hostKey, sessionId)}`;

const phaseOf = (turn: NeedsYouTurn): TurnPhase => {
  if (turn.state === "working") return "working";

  return turn.backgroundTasks > 0 || turn.backgroundReportsPending === true ? "waiting" : "settled";
};

/** The session's track after this summary: the same user Turn moves on, a new one starts over. */
const advance = (turn: NeedsYouTurn, was: TurnTrack | undefined, now: number): TurnTrack => {
  const phase = phaseOf(turn);
  const id = turn.userTurn?.id ?? null;
  const underWay = phase === "settled" ? null : turn.updatedAt;

  if (was !== undefined && was.userTurnId === id) {
    const settling = phase === "settled" && was.phase !== "settled";
    const settledAt = phase === "settled" ? (settling ? now : was.settledAt) : null;

    return { ...was, phase, startedAt: was.startedAt ?? underWay, settledAt };
  }

  // A snapshot forgets the user Turn: an unknown one under way keeps the start already seen.
  const carried = id === null && phase !== "settled" ? was?.startedAt : undefined;

  return {
    phase,
    userTurnId: id,
    startedAt: turn.userTurn?.startedAt ?? carried ?? underWay,
    done: false,
    settledAt: null,
  };
};

const longEnough = (turn: NeedsYouTurn, track: TurnTrack, minDurationMs: number | null) => {
  // A Review's run notifies whatever its length.
  if (minDurationMs === null || turn.review !== undefined) return true;

  if (track.startedAt === null) return false;

  return Date.parse(turn.updatedAt) - Date.parse(track.startedAt) > minDurationMs;
};

const targetKey = (target: ReviewTarget) =>
  target.kind === "pull"
    ? `pull ${target.repo.owner}/${target.repo.name}#${target.number}`.toLowerCase()
    : `session ${target.hostKey}\u0000${target.sessionId}`;

/** The focused window shows this session, or the Review this run belongs to. */
const onScreen = (turn: NeedsYouTurn, summary: NeedsYouSummary) => {
  const target = turn.review?.target ?? null;
  const reviewing = summary.reviewing ?? null;

  if (target !== null && reviewing !== null && targetKey(target) === targetKey(reviewing))
    return true;

  return summary.focused?.hostKey === turn.hostKey && summary.focused.sessionId === turn.sessionId;
};

interface Completion {
  readonly turn: NeedsYouTurn;
  readonly track: TurnTrack;
  readonly input: TurnPlanInput;
}

const notifies = ({ turn, track, input }: Completion) =>
  !(input.windowFocused && onScreen(turn, input.summary)) &&
  turn.digestStarted !== true &&
  longEnough(turn, track, input.minDurationMs ?? null);

interface Step {
  readonly track: TurnTrack;
  readonly show: boolean;
  /** Still waiting out `SETTLE_MS`: how long is left. */
  readonly waitMs: number | null;
}

/** Decides a settled Turn once its settle has held for `SETTLE_MS`. */
const step = (turn: NeedsYouTurn, track: TurnTrack, input: TurnPlanInput): Step => {
  if (track.done || track.settledAt === null) return { track, show: false, waitMs: null };
  const left = track.settledAt + SETTLE_MS - input.now;

  if (left > 0) return { track, show: false, waitMs: left };

  return {
    track: { ...track, done: true, settledAt: null },
    show: notifies({ turn, track, input }),
    waitMs: null,
  };
};

/** A decided user Turn is kept while its session is out of the summary (a reconnect, a reload). */
const kept = (track: TurnTrack) => track.done && track.userTurnId !== null;

/** Tracks of sessions this summary leaves out that still matter. */
const carryOver = (state: TurnState, summary: NeedsYouSummary, next: Map<string, TurnTrack>) => {
  // A session that needs you mid-Turn is still in it: keep its track until it goes Idle.
  for (const session of summary.sessions) {
    const key = turnKey(session.hostKey, session.sessionId);
    const was = state.get(key);

    if (was !== undefined && was.phase !== "settled" && !next.has(key)) next.set(key, was);
  }

  for (const [key, was] of state) if (!next.has(key) && kept(was)) next.set(key, was);
};

export const planTurnNotifications = (input: TurnPlanInput): TurnPlan => {
  const { state, summary, now } = input;
  const next = new Map<string, TurnTrack>();
  const show: Array<TurnNotification> = [];
  const close: Array<string> = [];
  let recheckInMs: number | null = null;

  for (const turn of summary.turns ?? []) {
    const key = turnKey(turn.hostKey, turn.sessionId);
    const was = state.get(key);
    const advanced = advance(turn, was, now);

    // The user's next Turn withdraws the last one's banner.
    if (was !== undefined && advanced.userTurnId !== null && was.userTurnId !== advanced.userTurnId)
      close.push(key);
    const { track, show: shows, waitMs } = step(turn, advanced, input);

    next.set(key, track);

    if (shows) show.push({ key, turn, ...turnContent(turn) });

    if (waitMs !== null) recheckInMs = Math.min(recheckInMs ?? waitMs, waitMs);
  }

  carryOver(state, summary, next);

  return { show, close, state: next, recheckInMs };
};
