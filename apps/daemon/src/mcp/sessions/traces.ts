import {
  type DeveloperMode,
  TraceAvailability,
  TraceError,
  type WorkspaceId,
} from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { DataSources } from "../../data/index.ts";
import type { TraceRuntime, TraceSessions, TraceStore } from "../../traces/index.ts";
import type { TraceSessionTools, TraceToolContext, TracesInput } from "../tools/traces.ts";
import { compareForSession } from "../../traces/compare.ts";
import { firstScope } from "../../traces/self/reads.ts";
import { SELF_CHECKOUT } from "../../traces/self/scope.ts";
import { matchingSource } from "../tools/spanFormat.ts";
import { captureSpans } from "./capture.ts";

const selfOff = () =>
  new TraceError({
    code: "E-TRACE-UNAVAILABLE",
    message:
      "Polaris's own traces are readable only from the Polaris Workspace while Developer Mode is on.",
    fix: "Omit scope to read this checkout; the user can turn on Developer Mode in Settings.",
  });

/** The Self-Trace scope alone: Polaris's own Spans carry no Turn, so every one is listed. */
const selfContext = (input: TracesInput): TraceToolContext => {
  const { turn: _turn, scope: _scope, ...filter } = input;

  return {
    checkout: SELF_CHECKOUT,
    scopes: [SELF_CHECKOUT],
    filter: { ...filter, limit: input.limit ?? 20 },
    turn: "all",
    endpoint: null,
  };
};

/** Reuse the Host's services and token-resolved checkout; no caller supplies an authority field. */
export const sessionTraceTools = (
  store: TraceStore["Service"],
  runtime: Pick<TraceRuntime["Service"], "setup">,
  sessions: Pick<TraceSessions["Service"], "session">,
  sources?: Pick<DataSources["Service"], "list">,
  developerMode?: Effect.Effect<DeveloperMode>,
  /** Overrides `trace_capture`'s wait for late batches (tests). */
  captureGraceMs?: number
): TraceSessionTools => {
  /** As the Traces view's `readScopes`: only a session in the Polaris Workspace, while on. */
  const selfReadable = (workspaceId: WorkspaceId) =>
    developerMode === undefined
      ? Effect.succeed(false)
      : Effect.map(
          developerMode,
          (mode) =>
            mode.effective &&
            mode.polarisWorkspaceId !== null &&
            mode.polarisWorkspaceId === workspaceId
        );

  const checkoutContext = Effect.fnUntraced(function* (
    id: Parameters<TraceSessionTools["context"]>[0],
    input: TracesInput
  ) {
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
    const { turn: _turn, scope: _scope, ...filter } = input;
    const self = yield* selfReadable(context.workspaceId);

    return {
      checkout: context.checkout,
      scopes: self ? ([context.checkout, SELF_CHECKOUT] as const) : ([context.checkout] as const),
      filter: {
        ...filter,
        limit: input.limit ?? 20,
        ...(requested === "all" ? undefined : { turn: turn?.id ?? null }),
      },
      turn: requested === "all" ? "all" : (turn?.number ?? null),
      endpoint: setup.endpoint,
    } satisfies TraceToolContext;
  });

  return {
    compare: (sessionId, a, b) => compareForSession(store, sessions, sessionId, a, b),
    context: Effect.fnUntraced(function* (id, input) {
      if (input.scope !== "self") return yield* checkoutContext(id, input);

      const session = yield* sessions.session(id);

      if (!(yield* selfReadable(session.workspaceId))) return yield* selfOff();

      return selfContext(input);
    }),
    list: Effect.fnUntraced(function* (context) {
      const page = yield* store.toolList(context.checkout, context.filter);

      if (page.total > 0 || (yield* store.list(context.checkout, { limit: 1 })).total > 0)
        return page;

      if (context.checkout === SELF_CHECKOUT)
        return yield* new TraceError({
          code: "E-TRACE-NONE",
          message: "No Self-Traces are kept yet.",
          fix: "Polaris's own spans arrive as the Daemon and apps work; try again shortly.",
        });
      const hint = context.scopes.length > 1 ? " For Polaris's own traces, pass scope self." : "";

      return yield* new TraceError({
        code: "E-TRACE-NONE",
        message: "No traces have reached this checkout.",
        fix: `Set up tracing in Traces (⌘5). Export to ${context.endpoint ?? "the session endpoint shown in Traces (http://127.0.0.1:4319/otlp/<token>)"}.${hint}`,
      });
    }),
    view: (context, id, focus) =>
      Effect.map(
        firstScope(context.scopes, (scope) => store.view(scope, id, focus)),
        ([view]) => view
      ),
    stats: (context, filter) => store.stats(context.checkout, filter),
    capture: (context, options) =>
      captureSpans(
        store,
        context.checkout,
        captureGraceMs === undefined ? options : { ...options, graceMs: captureGraceMs }
      ),
    span: Effect.fnUntraced(function* (sessionId, context, trace, span) {
      const [result] = yield* firstScope(context.scopes, (scope) =>
        store.toolSpan(scope, trace, span)
      );

      const { detail } = result;

      if (sources === undefined) return result;
      const available = yield* sources.list({ sessionId }).pipe(Effect.orElseSucceed(() => []));
      const dataSource = matchingSource(detail.span, available);

      return { ...result, ...(dataSource === undefined ? undefined : { dataSource }) };
    }),
  };
};
