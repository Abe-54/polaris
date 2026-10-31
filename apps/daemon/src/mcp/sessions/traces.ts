import { TraceAvailability, TraceError } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { DataSources } from "../../data/index.ts";
import type { TraceRuntime, TraceSessions, TraceStore } from "../../traces/index.ts";
import type { TraceSessionTools } from "../tools/traces.ts";
import { compareForSession } from "../../traces/compare.ts";
import { attributeValue } from "../tools/traceFormat.ts";
import { matchingSource } from "../tools/spanFormat.ts";

/** Reuse the Host's services and token-resolved checkout; no caller supplies an authority field. */
export const sessionTraceTools = (
  store: TraceStore["Service"],
  runtime: Pick<TraceRuntime["Service"], "setup">,
  sessions: Pick<TraceSessions["Service"], "session">,
  sources?: Pick<DataSources["Service"], "list">
): TraceSessionTools => ({
  compare: (sessionId, a, b) => compareForSession(store, sessions, sessionId, a, b),
  context: Effect.fnUntraced(function* (id, input) {
    const context = yield* sessions.session(id);
    const setup = yield* runtime.setup(id);

    if (TraceAvailability.guards.Unavailable(setup.availability))
      return yield* new TraceError({
        code: "E-TRACE-UNAVAILABLE",
        message: setup.availability.message,
        fix: "The user can check Traces (⌘5) and Set up tracing; free port 4319 if another process owns it.",
      });
    const requested = input.turn ?? "current";
    const current = context.turns.findLast((turn) => turn.end === null)?.turn ?? null;

    const turn = Schema.is(Schema.Number)(requested)
      ? context.turns.find((t) => t.turn.number === requested)?.turn
      : current;

    if (Schema.is(Schema.Number)(requested) && turn == null)
      return yield* new TraceError({
        code: "E-TRACE-NOT-FOUND",
        message: `Turn ${requested} isn't in this agent session.`,
        fix: "Use an existing turn number or turn all.",
      });
    const { turn: _turn, ...filter } = input;

    return {
      checkout: context.checkout,
      filter: {
        ...filter,
        limit: input.limit ?? 20,
        ...(requested === "all" ? undefined : { turn: turn?.id ?? null }),
      },
      turn: requested === "all" ? "all" : (turn?.number ?? null),
      endpoint: setup.endpoint,
    };
  }),
  list: Effect.fnUntraced(function* (context) {
    const page = yield* store.list(context.checkout, context.filter);

    if (page.total === 0 && (yield* store.list(context.checkout, { limit: 1 })).total === 0)
      return yield* new TraceError({
        code: "E-TRACE-NONE",
        message: "No traces have reached this checkout.",
        fix: `Set up tracing in Traces (⌘5). Export to ${context.endpoint ?? "the session endpoint shown in Traces (http://127.0.0.1:4319/otlp/<token>)"}.`,
      });
    const history: Record<string, number> = {};
    const errors: Record<string, string> = {};

    for (const trace of page.traces) {
      const baseline = yield* store.history(context.checkout, trace.id, false);

      if (baseline.root !== null && trace.durationMs > 20 && trace.durationMs > baseline.root * 3)
        history[trace.id] = baseline.root;

      if (trace.errors > 0) {
        const detail = yield* store.get(context.checkout, trace.id);
        const error = detail.spans.find((span) => span.status === "error");
        errors[trace.id] = attributeValue(
          error?.events.find((event) => event.name === "exception")?.attributes[
            "exception.message"
          ],
          error?.statusMessage ?? ""
        );
      }
    }

    return { ...page, history, errors };
  }),
  get: (checkout, id) => store.get(checkout, id),
  history: (checkout, id) => store.history(checkout, id),
  span: Effect.fnUntraced(function* (sessionId, checkout, trace, span) {
    const detail = yield* store.span(checkout, trace, span);

    if (sources === undefined) return { detail };
    const available = yield* sources.list({ sessionId }).pipe(Effect.orElseSucceed(() => []));
    const dataSource = matchingSource(detail.span, available);

    return { detail, ...(dataSource === undefined ? undefined : { dataSource }) };
  }),
});
