/**
 * Traces' boundary (ADR 0094): `traces.watch`, `traces.get`, `traces.span` and `traces.compare`,
 * typed by the protocol alone. `liveTracesApi` goes over IPC (shared/tracesContract.ts); fixtures
 * swap in.
 */
import type {
  SpanDetail,
  SpanIdPrefix,
  TraceCompareSelector,
  TraceComparison,
  TraceDetail,
  TraceFilter,
  TraceIdPrefix,
  TracesSnapshot,
} from "@polaris/protocol";
import type { IpcError, Result } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import type { TracesSessionKey } from "../model/session.ts";

export interface Snapshots {
  /** The latest snapshot; each one replaces the last. */
  readonly next: (snapshot: TracesSnapshot) => void;
  readonly end?: (error: IpcError | null) => void;
}

export interface TracesApi {
  /** The checkout's traces matching `filter`; the returned function stops watching. */
  readonly watch: (
    at: TracesSessionKey,
    filter: TraceFilter | undefined,
    on: Snapshots
  ) => () => void;
  /** One trace and all its retained spans; `traceId` may be a unique prefix (8+ hex). */
  readonly get: (
    at: TracesSessionKey,
    traceId: typeof TraceIdPrefix.Type
  ) => Promise<Result<TraceDetail>>;
  /** One span with its newest 20 log records. */
  readonly span: (
    at: TracesSessionKey,
    traceId: typeof TraceIdPrefix.Type,
    spanId: typeof SpanIdPrefix.Type
  ) => Promise<Result<SpanDetail>>;
  /** Per route, `a`'s traces (before) against `b`'s (after); needs `traces.compare`. */
  readonly compare: (
    at: TracesSessionKey,
    a: TraceCompareSelector,
    b: TraceCompareSelector
  ) => Promise<Result<TraceComparison>>;
}

const session = (at: TracesSessionKey) => ({ hostKey: at.hostKey, sessionId: at.sessionId });

export const liveTracesApi: TracesApi = {
  watch: (at, filter, on) =>
    polaris().subscribe(
      "traces.watch",
      filter === undefined ? session(at) : { ...session(at), filter },
      {
        items: (items) => {
          const last = items.at(-1);

          if (last !== undefined) on.next(last);
        },
        end: (error) => on.end?.(error),
      }
    ),
  get: (at, traceId) => polaris().request("traces.get", { ...session(at), traceId }),
  span: (at, traceId, spanId) =>
    polaris().request("traces.span", { ...session(at), traceId, spanId }),
  compare: (at, a, b) => polaris().request("traces.compare", { ...session(at), a, b }),
};
