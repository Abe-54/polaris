/**
 * The hooks Data's views read through, over whichever `DataApi` the nearest `DataLayer`
 * provides: the live IPC one by default, fixtures in previews and tests.
 */
import type { DataSource, QueryLogEntry, SchemaTree, TableDetail } from "@polaris/protocol";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { IpcError } from "../../../../shared/api.ts";
import type { DataSessionKey } from "../model/store.ts";
import { type DataApi, type DescribeInput, liveDataApi, type Snapshots } from "./api.ts";

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

const useWatch = <A,>(
  at: DataSessionKey,
  watch: (api: DataApi) => (at: DataSessionKey, on: Snapshots<A>) => () => void
): Loaded<ReadonlyArray<A>> => {
  const api = useDataApi();
  const [state, setState] = useState<Loaded<ReadonlyArray<A>>>(LOADING);
  const { hostKey, sessionId } = at;

  useEffect(() => {
    setState(LOADING);

    return watch(api)(
      { hostKey, sessionId },
      {
        next: (value) => setState({ status: "ready", value }),
        end: (error) => {
          if (error !== null) setState({ status: "failed", error });
        },
      }
    );
  }, [api, watch, hostKey, sessionId]);

  return state;
};

const sources = (api: DataApi) => api.watchSources;

const queryLog = (api: DataApi) => api.watchQueryLog;

/** The checkout's Data Sources, live. */
export const useDataSources = (at: DataSessionKey): Loaded<ReadonlyArray<DataSource>> =>
  useWatch(at, sources);

/** The checkout's Query Log, newest last, live. */
export const useQueryLog = (at: DataSessionKey): Loaded<ReadonlyArray<QueryLogEntry>> =>
  useWatch(at, queryLog);

/** A Data Source's schema tree, or one table's detail when `table` is given. */
export const useDescribe = (
  at: DataSessionKey,
  input: DescribeInput | null
): Loaded<SchemaTree | TableDetail> => {
  const api = useDataApi();
  const [state, setState] = useState<Loaded<SchemaTree | TableDetail>>(LOADING);
  const { hostKey, sessionId } = at;
  const source = input?.source;
  const table = input?.table;
  const sample = input?.sample;

  useEffect(() => {
    if (source === undefined) return;
    let live = true;

    setState(LOADING);
    void api.describe({ hostKey, sessionId }, { source, table, sample }).then((result) => {
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
  }, [api, hostKey, sessionId, source, table, sample]);

  return state;
};
