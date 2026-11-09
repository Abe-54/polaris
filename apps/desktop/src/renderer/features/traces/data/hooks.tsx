/**
 * The hooks Traces' views read through, over whichever `TracesApi` the nearest `TracesLayer`
 * provides: the live IPC one by default, fixtures in previews and tests.
 */
import type {
  LogRecord,
  SpanDetail,
  TraceDetail,
  TraceFilter,
  TracesSnapshot,
} from "@polaris/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { IpcError, Result } from "../../../../shared/api.ts";
import { useApp } from "../../../shell/hooks.ts";
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
 * Reads again when `api`, `key` or `generation` changes (`key` names everything `load` reads);
 * loading shows only when `key` changes, so a new api or generation keeps the last answer until
 * the fresh one arrives. A null `key` reads nothing and drops the last answer.
 */
export const useLoadedWith = <Api, A>(
  api: Api,
  key: string | null,
  load: Load<A, Api>,
  generation: number | string = 0
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
  }, [api, key, generation]);

  return state;
};

const useLoaded = <A,>(
  key: string | null,
  load: Load<A>,
  generation: number | string = 0
): Loaded<A> => useLoadedWith(useTracesApi(), key, load, generation);

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

/**
 * Counts the changes of `version` for one trace, from its first known value: the first listing
 * of an already open trace reads nothing again; each later change reads it once.
 */
const useGrowth = (traceId: string | null, version: string | null) => {
  const [seen, setSeen] = useState({ traceId, version, n: 0 });

  if (seen.traceId !== traceId) setSeen({ traceId, version, n: 0 });
  else if (version !== null && version !== seen.version)
    setSeen({ traceId, version, n: seen.version === null ? seen.n : seen.n + 1 });

  return seen.n;
};

/** The Host's connection: its epoch, which moves on each reconnect, and whether it's connected. */
export const useConnectionOf = (hostKey: string) => {
  const epoch = useApp((s) => s.hosts.find((h) => h.key === hostKey)?.status.epoch ?? 0);

  const connected = useApp(
    (s) => s.hosts.find((h) => h.key === hostKey)?.status.state === "connected"
  );

  return { epoch, connected };
};

/**
 * The checkout's traces under `filter`, live: each snapshot replaces the last. The main process
 * ends the watch with the connection, so it opens again on each new epoch; a watch that fails
 * while the Host is away keeps the last snapshot (rule/remote-is-normal).
 */
export const useTraces = (at: TracesSessionKey, filter?: TraceFilter): Loaded<TracesSnapshot> => {
  const { epoch, connected } = useConnectionOf(at.hostKey);
  const away = useRef(!connected);

  away.current = !connected;

  return useLoaded(
    keyOf(at.hostKey, at.sessionId, at.scope ?? null, filter ?? null),
    (api, set) =>
      api.watch(at, filter, {
        next: (value) => set({ status: "ready", value }),
        end: (error) => {
          if (error !== null && !away.current) set({ status: "failed", error });
        },
      }),
    epoch
  );
};

/**
 * One trace's spans; nothing is read while `traceId` is null. A new `version` (the listed
 * summary's, model/listed.ts) reads it again, keeping the shown spans until the answer comes.
 */
export const useTrace = (
  at: TracesSessionKey,
  traceId: string | null,
  version: string | null = null
): Loaded<TraceDetail> =>
  useLoaded(
    traceId === null ? null : keyOf(at.hostKey, at.sessionId, at.scope ?? null, traceId),
    settle((api) => api.get(at, traceId ?? "")),
    useGrowth(traceId, version)
  );

/** One span with its logs; nothing is read until both ids are set. */
export const useSpan = (
  at: TracesSessionKey,
  traceId: string | null,
  spanId: string | null
): Loaded<SpanDetail> =>
  useLoaded(
    traceId === null || spanId === null
      ? null
      : keyOf(at.hostKey, at.sessionId, at.scope ?? null, traceId, spanId),
    settle((api) => api.span(at, traceId ?? "", spanId ?? ""))
  );

export interface OlderLogs {
  /** Records read past the newest page, oldest last. */
  readonly logs: ReadonlyArray<LogRecord>;
  readonly reading: boolean;
  readonly error: IpcError | null;
  /** Reads the page before the oldest record shown (`shown`: the newest page, then `logs`). */
  readonly more: (shown: ReadonlyArray<LogRecord>) => void;
}

const NO_OLDER = { key: "", logs: [], reading: false, error: null } as const;

/** A span's older log pages, read on demand with `traces.span`'s `before`; a new span starts over. */
export const useOlderLogs = (at: TracesSessionKey, traceId: string, spanId: string): OlderLogs => {
  const api = useTracesApi();
  const key = keyOf(at.hostKey, at.sessionId, at.scope ?? null, traceId, spanId);

  const [state, setState] = useState<{
    readonly key: string;
    readonly logs: ReadonlyArray<LogRecord>;
    readonly reading: boolean;
    readonly error: IpcError | null;
  }>({ ...NO_OLDER, key });

  const current = state.key === key ? state : { ...NO_OLDER, key };
  const live = useRef(key);

  live.current = key;

  const more = useCallback(
    (shown: ReadonlyArray<LogRecord>) => {
      const last = shown.at(-1);

      if (last === undefined) return;
      setState((s) => ({
        ...(s.key === key ? s : { ...NO_OLDER, key }),
        reading: true,
        error: null,
      }));
      void api
        .span(at, traceId, spanId, { timeUnixNano: last.timeUnixNano, id: last.id })
        .then((result) => {
          if (live.current !== key) return;
          setState((s) => {
            if (!result.ok) return { ...s, reading: false, error: result.error };
            const seen = new Set([...shown, ...s.logs].map((l) => l.id));

            return {
              ...s,
              reading: false,
              logs: [...s.logs, ...result.value.logs.filter((l) => !seen.has(l.id))],
            };
          });
        });
    },
    [api, at, traceId, spanId, key]
  );

  return { logs: current.logs, reading: current.reading, error: current.error, more };
};
