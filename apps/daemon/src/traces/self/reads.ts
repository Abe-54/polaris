/**
 * Where a session's trace reads look: its checkout, the Self-Trace scope beside it in the
 * Polaris Workspace, or the Self-Trace scope alone (`scope: "self"`).
 */
import type {
  SessionId,
  TraceError,
  TraceFilter,
  TraceSummary,
  WorkspaceId,
} from "@polaris/protocol";
import { Effect, Stream } from "effect";
import type { TraceRuntime } from "../runtimeService.ts";
import type { TraceSessions } from "../sessionsService.ts";
import type { TracePage } from "../store.ts";
import type { TraceStore } from "../storeService.ts";
import { SELF_CHECKOUT } from "./scope.ts";
import { selfTracer } from "./tracer.ts";

export const DEFAULT_LIMIT = 50;

/** The scopes to read, first the one a prefix resolves in when both hold it. */
export type ReadScopes = readonly [string] | readonly [string, string];

interface ScopeOptions {
  readonly runtime: TraceRuntime["Service"];
  readonly sessions: TraceSessions["Service"];
  readonly polarisWorkspace: Effect.Effect<WorkspaceId | null>;
  readonly sessionId: SessionId;
  readonly scope: "self" | undefined;
}

export const readScopes = (options: ScopeOptions): Effect.Effect<ReadScopes, TraceError> =>
  resolveScopes(options).pipe(
    // Self-Spans wait in memory for a batch (ENG-721); a read sends what is waiting.
    Effect.tap((scopes) =>
      Effect.sync(() => {
        if (scopes.includes(SELF_CHECKOUT)) selfTracer.flush();
      })
    )
  );

const resolveScopes = (options: ScopeOptions): Effect.Effect<ReadScopes, TraceError> =>
  Effect.gen(function* () {
    const checkout = yield* options.runtime.checkout(options.sessionId);

    if (options.scope === "self") return [SELF_CHECKOUT] as const;
    const polaris = yield* options.polarisWorkspace;

    if (polaris === null) return [checkout] as const;
    const session = yield* options.sessions.session(options.sessionId);

    return session.workspaceId === polaris ? ([checkout, SELF_CHECKOUT] as const) : [checkout];
  });

const newestFirst = (a: TraceSummary, b: TraceSummary) => {
  const start = BigInt(b.startTimeUnixNano) - BigInt(a.startTimeUnixNano);

  if (start !== 0n) return start > 0n ? 1 : -1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** Both pages keep the store's order: newest start first, trace id breaking ties. */
export const mergePages = (pages: ReadonlyArray<TracePage>, limit = DEFAULT_LIMIT): TracePage => ({
  traces: pages
    .flatMap((page) => page.traces)
    .toSorted(newestFirst)
    .slice(0, limit),
  total: pages.reduce((total, page) => total + page.total, 0),
});

export const watchScopes = (
  store: TraceStore["Service"],
  scopes: ReadScopes,
  filter: TraceFilter | undefined
): Stream.Stream<TracePage, TraceError> =>
  scopes.length === 1
    ? store.watch(scopes[0], filter)
    : Stream.zipLatestWith(store.watch(scopes[0], filter), store.watch(scopes[1], filter), (a, b) =>
        mergePages([a, b], filter?.limit)
      );

/** Reads in the first scope that has the trace; any error but not-found stops there. */
export const firstScope = <A>(
  scopes: ReadScopes,
  read: (scope: string) => Effect.Effect<A, TraceError>
): Effect.Effect<readonly [A, string], TraceError> => {
  const attempt = (index: number): Effect.Effect<readonly [A, string], TraceError> => {
    const scope = scopes[index]!;
    const result = Effect.map(read(scope), (value) => [value, scope] as const);

    return index + 1 >= scopes.length
      ? result
      : result.pipe(
          Effect.catchTag("TraceError", (error) =>
            error.code === "E-TRACE-NOT-FOUND" ? attempt(index + 1) : Effect.fail(error)
          )
        );
  };

  return attempt(0);
};
