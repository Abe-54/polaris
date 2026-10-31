/**
 * The hooks Traces' views read through, over whichever `TracesApi` the nearest `TracesLayer`
 * provides: the live IPC one by default, fixtures in previews and tests.
 */
import type { SpanDetail, TraceDetail, TraceFilter, TracesSnapshot } from "@polaris/protocol";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import type { IpcError, Result } from "../../../../shared/api.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { liveTracesApi, type TracesApi } from "./api.ts";

const ApiContext = createContext<TracesApi>(liveTracesApi);

export const TracesLayer = ({ api, children }: { api: TracesApi; children: ReactNode }) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useTracesApi = () => useContext(ApiContext);

export type Loaded<A> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: A }
  | { readonly status: "failed"; readonly error: IpcError };

const LOADING = { status: "loading" } as const;

type Load<A, Api = TracesApi> = (api: Api, set: (next: Loaded<A>) => void) => () => void;

/**
 * Reads again when `api` or `key` changes (`key` names everything `load` reads); loading shows
 * only when `key` changes, so a new api keeps the last answer until the fresh one arrives. A null
 * `key` reads nothing and drops the last answer.
 */
export const useLoadedWith = <Api, A>(
  api: Api,
  key: string | null,
  load: Load<A, Api>
): Loaded<A> => {
  const [state, setState] = useState<Loaded<A>>(LOADING);
  const shown = useRef<string | null>(null);
  const latest = useRef(load);

  latest.current = load;

  useEffect(() => {
    if (shown.current !== key) setState(LOADING);
    shown.current = key;

    if (key === null) return undefined;

    return latest.current(api, setState);
  }, [api, key]);

  return state;
};

const useLoaded = <A,>(key: string | null, load: Load<A>): Loaded<A> =>
  useLoadedWith(useTracesApi(), key, load);

export const settle =
  <A, Api = TracesApi>(request: (api: Api) => Promise<Result<A>>): Load<A, Api> =>
  (api, set) => {
    let live = true;

    void request(api).then((result) => {
      if (live)
        set(
          result.ok
            ? { status: "ready", value: result.value }
            : { status: "failed", error: result.error }
        );
    });

    return () => {
      live = false;
    };
  };

export const keyOf = (...parts: ReadonlyArray<unknown>) => JSON.stringify(parts);

/** The checkout's traces under `filter`, live: each snapshot replaces the last. */
export const useTraces = (at: TracesSessionKey, filter?: TraceFilter): Loaded<TracesSnapshot> =>
  useLoaded(keyOf(at.hostKey, at.sessionId, filter ?? null), (api, set) =>
    api.watch(at, filter, {
      next: (value) => set({ status: "ready", value }),
      end: (error) => {
        if (error !== null) set({ status: "failed", error });
      },
    })
  );

/** One trace's spans; nothing is read while `traceId` is null. */
export const useTrace = (at: TracesSessionKey, traceId: string | null): Loaded<TraceDetail> =>
  useLoaded(
    traceId === null ? null : keyOf(at.hostKey, at.sessionId, traceId),
    settle((api) => api.get(at, traceId ?? ""))
  );

/** One span with its logs; nothing is read until both ids are set. */
export const useSpan = (
  at: TracesSessionKey,
  traceId: string | null,
  spanId: string | null
): Loaded<SpanDetail> =>
  useLoaded(
    traceId === null || spanId === null ? null : keyOf(at.hostKey, at.sessionId, traceId, spanId),
    settle((api) => api.span(at, traceId ?? "", spanId ?? ""))
  );
