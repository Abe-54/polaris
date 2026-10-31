import { TraceCompareSelector, TraceError, type SessionId } from "@polaris/protocol";
import { Effect } from "effect";
import type { TraceSessions } from "./sessions.ts";
import type { TraceStore } from "./store.ts";

export const compareInputError = () =>
  new TraceError({
    code: "E-INPUT",
    message: "Invalid trace comparison selectors.",
    fix: 'Send a: {_tag:"Baseline"} with b: {_tag:"Turn",turnId}, two Turn selectors, or two Trace selectors. Baseline cannot be b.',
  });

/** Turn ids resolve in the caller's Agent Session; the store never accepts checkout authority from input. */
export const compareForSession = Effect.fnUntraced(function* (
  store: TraceStore["Service"],
  sessions: Pick<TraceSessions["Service"], "session">,
  sessionId: SessionId,
  a: TraceCompareSelector,
  b: TraceCompareSelector
) {
  if (
    TraceCompareSelector.guards.Baseline(b) ||
    (TraceCompareSelector.guards.Baseline(a) && !TraceCompareSelector.guards.Turn(b)) ||
    (TraceCompareSelector.guards.Trace(a) && !TraceCompareSelector.guards.Trace(b)) ||
    (TraceCompareSelector.guards.Turn(a) && !TraceCompareSelector.guards.Turn(b))
  )
    return yield* compareInputError();

  const context = yield* sessions.session(sessionId);

  for (const selector of [a, b]) {
    if (
      TraceCompareSelector.guards.Turn(selector) &&
      !context.turns.some((interval) => interval.turn.id === selector.turnId)
    )
      return yield* new TraceError({
        code: "E-TRACE-NOT-FOUND",
        message: "The selected turn isn't in this agent session.",
        fix: "Send an existing turn id from this agent session, or two trace ids in this checkout.",
      });
  }

  const start = TraceCompareSelector.guards.Turn(b)
    ? context.turns.find((interval) => interval.turn.id === b.turnId)!.start
    : undefined;

  return yield* store.compare(context.checkout, a, b, start);
});
