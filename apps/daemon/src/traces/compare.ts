import { TraceCompareSelector, TraceError, type SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { TraceSessions } from "./sessions.ts";
import type { TraceStore } from "./store.ts";
import type { CompareTurns } from "./compareQuery.ts";

export const compareInputError = () =>
  new TraceError({
    code: "E-INPUT",
    message: "Invalid trace comparison selectors.",
    fix: 'Send a: {_tag:"Baseline"} with b: {_tag:"Turn",turnId} or {_tag:"Turns",firstTurnId,lastTurnId}, two Turn or Turns selectors, or two Trace selectors. Baseline cannot be b.',
  });

const notInSession = () =>
  new TraceError({
    code: "E-TRACE-NOT-FOUND",
    message: "The selected turn isn't in this agent session.",
    fix: "Send an existing turn id from this agent session, or two trace ids in this checkout.",
  });

const reversed = () =>
  new TraceError({
    code: "E-INPUT",
    message: "The turn range ends before it starts.",
    fix: "Send firstTurnId at or before lastTurnId in this agent session.",
  });

const turnLike = (selector: TraceCompareSelector) =>
  TraceCompareSelector.guards.Turn(selector) || TraceCompareSelector.guards.Turns(selector);

const validPair = (a: TraceCompareSelector, b: TraceCompareSelector) =>
  TraceCompareSelector.guards.Trace(a)
    ? TraceCompareSelector.guards.Trace(b)
    : turnLike(b) && !TraceCompareSelector.guards.Baseline(b);

type Interval = Effect.Success<ReturnType<TraceSessions["Service"]["session"]>>["turns"][number];

/** A Turn or Turns selector's intervals in session order; undefined for Baseline and Trace. */
const resolve = (
  turns: ReadonlyArray<Interval>,
  selector: TraceCompareSelector
): Effect.Effect<ReadonlyArray<Interval> | undefined, TraceError> => {
  if (!turnLike(selector)) return Effect.succeed(undefined);

  const [first, last] = TraceCompareSelector.guards.Turn(selector)
    ? [selector.turnId, selector.turnId]
    : [selector.firstTurnId, selector.lastTurnId];

  const from = turns.findIndex((interval) => interval.turn.id === first);
  const to = turns.findIndex((interval) => interval.turn.id === last);

  if (from < 0 || to < 0) return Effect.fail(notInSession());

  return to < from ? Effect.fail(reversed()) : Effect.succeed(turns.slice(from, to + 1));
};

/** The Turn ids each side resolved to, and Baseline's start: the target's first Turn's. */
const resolution = (
  before: ReadonlyArray<Interval> | undefined,
  after: ReadonlyArray<Interval> | undefined
): CompareTurns => ({
  ...(before === undefined ? undefined : { a: before.map((interval) => interval.turn.id) }),
  ...(after === undefined
    ? undefined
    : // SAFETY: resolve slices from..to inclusive, so a resolved side has at least one Turn.
      { b: after.map((interval) => interval.turn.id), baselineStart: after[0]!.start }),
});

/** Turn ids resolve in the caller's Agent Session; the store never accepts checkout authority from input. */
export const compareForSession = Effect.fnUntraced(function* (
  store: TraceStore["Service"],
  sessions: Pick<TraceSessions["Service"], "session">,
  sessionId: SessionId,
  a: TraceCompareSelector,
  b: TraceCompareSelector
) {
  if (!validPair(a, b)) return yield* compareInputError();

  const context = yield* sessions.session(sessionId);
  const before = yield* resolve(context.turns, a);
  const after = yield* resolve(context.turns, b);

  return yield* store.compare(context.checkout, a, b, resolution(before, after));
});
