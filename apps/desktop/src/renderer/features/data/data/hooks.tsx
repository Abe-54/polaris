/**
 * The hooks Data's views read through, over whichever `DataApi` the nearest `DataLayer`
 * provides: the live IPC one by default, fixtures in previews and tests.
 */
import type { DataSource, QueryLogEntry, SchemaTree, TableDetail } from "@polaris/protocol";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useHostDeveloperMode } from "../../settings/hostDeveloperModes.ts";
import {
  daemonSwitchShown,
  setDaemonSwitch,
  shownSources,
  useDaemonSwitch,
} from "../model/daemon.ts";
import type { IpcError } from "../../../../shared/api.ts";
import { markListed, useSourcesGeneration } from "../model/refresh.ts";
import { type DataSessionKey, dataSessionKey } from "../model/store.ts";
import {
  type DataApi,
  type DescribeInput,
  liveDataApi,
  type Snapshots,
  type TableChange,
  type TraceOf,
} from "./api.ts";

const ApiContext = createContext<DataApi>(liveDataApi);

export const DataLayer = ({ api, children }: { api: DataApi; children: ReactNode }) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

/** For actions (Run, re-run): the api the views read through. */
export const useDataApi = () => useContext(ApiContext);

export type Loaded<A> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: A }
  | { readonly status: "failed"; readonly error: IpcError };

const LOADING = { status: "loading" } as const;

/**
 * A new `generation` re-subscribes and keeps the last snapshot until the fresh one arrives;
 * `enabled` false subscribes to nothing.
 */
const useWatch = <A,>(
  at: DataSessionKey,
  watch: (api: DataApi) => (at: DataSessionKey, on: Snapshots<A>) => () => void,
  generation = 0,
  onListed?: (at: DataSessionKey, generation: number) => void,
  enabled = true
): Loaded<ReadonlyArray<A>> => {
  const api = useDataApi();
  const [state, setState] = useState<Loaded<ReadonlyArray<A>>>(LOADING);
  const { hostKey, sessionId } = at;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    const key = dataSessionKey({ hostKey, sessionId });

    if (shown.current !== key) setState(LOADING);
    shown.current = key;

    return watch(api)(
      { hostKey, sessionId },
      {
        next: (value) => {
          setState({ status: "ready", value });
          onListed?.({ hostKey, sessionId }, generation);
        },
        end: (error) => {
          if (error !== null) setState({ status: "failed", error });
        },
      }
    );
  }, [api, watch, hostKey, sessionId, generation, onListed, enabled]);

  return state;
};

const sources = (api: DataApi) => api.watchSources;

const queryLog = (api: DataApi) => api.watchQueryLog;

export interface DataSourcesView {
  readonly sources: Loaded<ReadonlyArray<DataSource>>;
  /** The Polaris switch for Daemon Sources, where it shows. */
  readonly polaris?: { readonly on: boolean; readonly set: (on: boolean) => void };
}

/** The checkout's Data Sources as Data shows them, live, and the Polaris switch if it shows. */
export const useDataSourcesView = (at: DataSessionKey): DataSourcesView => {
  const listed = useWatch(at, sources, useSourcesGeneration(at), markListed);
  const mode = useHostDeveloperMode(at.hostKey);
  const on = useDaemonSwitch(at.hostKey);
  const { hostKey } = at;

  return useMemo(() => {
    if (listed.status !== "ready") return { sources: listed };
    const shown = daemonSwitchShown(listed.value, mode);
    const value = shownSources(listed.value, shown, on);

    const ready = { status: "ready", value } as const;

    if (!shown) return { sources: ready };

    return {
      sources: ready,
      polaris: { on, set: (next: boolean) => setDaemonSwitch(hostKey, next) },
    };
  }, [listed, mode, on, hostKey]);
};

/** The checkout's Data Sources, live; `refreshSources` re-lists them. */
export const useDataSources = (at: DataSessionKey): Loaded<ReadonlyArray<DataSource>> =>
  useDataSourcesView(at).sources;

/** The checkout's Query Log, newest last, live; nothing is watched while `enabled` is false. */
export const useQueryLog = (
  at: DataSessionKey,
  enabled = true
): Loaded<ReadonlyArray<QueryLogEntry>> => useWatch(at, queryLog, 0, undefined, enabled);

const tableChanges = (api: DataApi) => api.watchTableChanges;

/** Tables agents added or changed this Turn, live. */
export const useTableChanges = (at: DataSessionKey): Loaded<ReadonlyArray<TableChange>> =>
  useWatch(at, tableChanges);

/**
 * A Data Source's schema tree, or one table's detail when `table` is given. A new `generation`
 * reads it again and keeps the last answer until the fresh one arrives.
 */
export const useDescribe = (
  at: DataSessionKey,
  input: DescribeInput | null,
  generation: string | number = 0,
  trace?: TraceOf
): Loaded<SchemaTree | TableDetail> => {
  const api = useDataApi();
  const [state, setState] = useState<Loaded<SchemaTree | TableDetail>>(LOADING);
  const { hostKey, sessionId } = at;
  const source = input?.source;
  const table = input?.table;
  const sample = input?.sample;
  const shown = useRef<string | null>(null);
  const traceOf = useRef(trace);

  traceOf.current = trace;

  useEffect(() => {
    if (source === undefined) return;
    let live = true;
    const key = [hostKey, sessionId, source, table, sample].join("\u0000");

    if (shown.current !== key) setState(LOADING);
    shown.current = key;
    const context = traceOf.current?.();
    const options = context === undefined ? undefined : { trace: context };

    void api.describe({ hostKey, sessionId }, { source, table, sample }, options).then((result) => {
      if (!live) return;
      setState(
        result.ok
          ? { status: "ready", value: result.value }
          : { status: "failed", error: result.error }
      );
    });

    return () => {
      live = false;
    };
  }, [api, hostKey, sessionId, source, table, sample, generation]);

  return state;
};
