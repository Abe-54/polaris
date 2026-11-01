/**
 * The Daemon's trace receiver, runtime and retention, for tests that check the desktop's setup
 * copy against what the Daemon does (RPU P10-1, P10-2).
 */
import type { Database } from "bun:sqlite";
import type { SessionId } from "@polaris/protocol";
import type { Effect } from "effect";

type Environment = Readonly<Record<string, string>>;

/** apps/daemon/src/traces: testing.ts's receiver fixture, database.ts and retention.ts. */
export interface DaemonTraces {
  readonly withTraceFixture: (
    run: (fixture: {
      /** The base endpoint the Daemon gives the fixture's session. */
      readonly endpoint: string | null;
      readonly context: { readonly sessionId: SessionId | null };
      readonly runtime: {
        readonly environment: (
          id: SessionId,
          source: Environment
        ) => Effect.Effect<Environment, unknown>;
      };
    }) => Promise<void>
  ) => Promise<void>;
  /** One OTLP/JSON export request with a single span. */
  readonly traceFixture: () => { readonly resourceSpans: ReadonlyArray<object> };
  readonly DEFAULT_RETENTION: { readonly maxBytes: number; readonly maxAgeMs: number };
  readonly openTraceDatabase: (filename: string) => Database;
  readonly pruneCheckout: (
    db: Database,
    checkout: string,
    retention: DaemonTraces["DEFAULT_RETENTION"],
    now: number
  ) => boolean;
}

const DAEMON_TRACES = new URL("../../../../../../daemon/src/traces/", import.meta.url);

/**
 * Loaded at run time so the renderer's DOM-typed tsconfig never compiles Daemon sources, as
 * review/traces/daemonFit.testing.tsx does; a drift from DaemonTraces fails these tests.
 */
const daemonModule = <M>(file: string): Promise<M> =>
  // SAFETY: `file` is one of the Daemon's testing.ts, database.ts and retention.ts, whose exports
  // DaemonTraces mirrors; a drift breaks these tests at their first call.
  import(new URL(file, DAEMON_TRACES).href) as Promise<M>;

const load = async (): Promise<DaemonTraces> => {
  const [testing, database, retention] = await Promise.all([
    daemonModule<Pick<DaemonTraces, "withTraceFixture" | "traceFixture">>("testing.ts"),
    daemonModule<Pick<DaemonTraces, "DEFAULT_RETENTION" | "openTraceDatabase">>("database.ts"),
    daemonModule<Pick<DaemonTraces, "pruneCheckout">>("retention.ts"),
  ]);

  return {
    withTraceFixture: testing.withTraceFixture,
    traceFixture: testing.traceFixture,
    DEFAULT_RETENTION: database.DEFAULT_RETENTION,
    openTraceDatabase: database.openTraceDatabase,
    pruneCheckout: retention.pruneCheckout,
  };
};

export const daemon = await load();
