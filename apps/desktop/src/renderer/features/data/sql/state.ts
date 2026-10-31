/**
 * Each SQL tab's live state, kept while its tab is open so switching tabs keeps the text, the
 * chosen Data Source and the last run: the tab model holds only what the tab opened with.
 */
import type { DataValue } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DataApi } from "../data/api.ts";
import { type DataSessionKey, dataSessionKey, dataTabsStore } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { type DataIpcError, type ErrorSpan, errorSpan } from "./sqlError.ts";

export type SqlTab = Extract<DataTab, { kind: "sql" }>;

export interface ResultSet {
  readonly columns: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly rows: ReadonlyArray<ReadonlyArray<DataValue>>;
  readonly returned: number;
  /** All the rows the query matched, when the Host counted them. */
  readonly total: number | undefined;
  readonly truncated: boolean;
  readonly elapsedMs: number;
}

export type SqlRun =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly id: number; readonly sql: string }
  | {
      readonly status: "done";
      readonly id: number;
      readonly sql: string;
      readonly result: ResultSet;
    }
  | { readonly status: "cancelled"; readonly id: number; readonly sql: string }
  | {
      readonly status: "failed";
      readonly id: number;
      readonly sql: string;
      readonly error: DataIpcError;
      readonly span: ErrorSpan | null;
    };

export interface SqlTabState {
  readonly text: string;
  /** The Data Source's name. */
  readonly source: string;
  readonly run: SqlRun;
  /** Why the tab opened without running, e.g. a Query Log re-run whose source is gone. */
  readonly notice: string | null;
}

const IDLE: SqlRun = { status: "idle" };

const sqlTabs = createStore<Readonly<Record<string, SqlTabState>>>(() => ({}));

const keyOf = (at: DataSessionKey, tabId: string) => `${dataSessionKey(at)}\u0000${tabId}`;

const initial = (tab: SqlTab): SqlTabState => ({
  text: tab.sql,
  source: tab.sourceId,
  run: IDLE,
  notice: tab.notice ?? null,
});

const patch = (at: DataSessionKey, tab: SqlTab, change: Partial<SqlTabState>) => {
  const key = keyOf(at, tab.id);

  sqlTabs.setState((all) => ({ ...all, [key]: { ...(all[key] ?? initial(tab)), ...change } }));
};

const read = (at: DataSessionKey, tab: SqlTab) =>
  sqlTabs.getState()[keyOf(at, tab.id)] ?? initial(tab);

export const useSqlTab = (at: DataSessionKey, tab: SqlTab): SqlTabState =>
  useStore(sqlTabs, (all) => all[keyOf(at, tab.id)]) ?? initial(tab);

export const setSqlText = (at: DataSessionKey, tab: SqlTab, text: string) =>
  patch(at, tab, { text });

/** The running query's cancel, by tab; it unsubscribes the stream, so the Host stops it too. */
const inFlight = new Map<
  string,
  { readonly session: string; readonly tabId: string; readonly cancel: () => void }
>();

const stop = (key: string) => {
  inFlight.get(key)?.cancel();
  inFlight.delete(key);
};

/** Cancels the tab's running query and says so; nothing while none runs. */
export const cancelSqlRun = (at: DataSessionKey, tab: SqlTab) => {
  const { run } = read(at, tab);

  if (run.status !== "running") return;
  stop(keyOf(at, tab.id));
  patch(at, tab, { run: { status: "cancelled", id: run.id, sql: run.sql } });
};

/** Choosing another Data Source cancels a query still running on the last one. */
export const setSqlSource = (at: DataSessionKey, tab: SqlTab, source: string) => {
  stop(keyOf(at, tab.id));
  patch(at, tab, { source, run: IDLE, notice: null });
};

// A closed tab's query is cancelled and its state dropped.
dataTabsStore.subscribe(({ sessions }) => {
  for (const [key, { session, tabId }] of inFlight)
    if (sessions[session]?.tabs.some((t) => t.id === tabId) !== true) stop(key);
});

let runs = 0;

/** Tabs to run once they mount: a Query Log re-run opens a tab with its query running. */
const queued = new Set<string>();

export const queueRun = (at: DataSessionKey, tabId: string) => queued.add(keyOf(at, tabId));

export const takeQueuedRun = (at: DataSessionKey, tabId: string) => queued.delete(keyOf(at, tabId));

/** Results are capped at 200 rows; the grid says when there were more. */
export const RESULT_LIMIT = 200;

interface Outcome {
  readonly done: (result: ResultSet) => void;
  readonly failed: (error: DataIpcError) => void;
}

/** The query through data.query.stream, which a cancel stops on the Host; else data.query. */
const start = (api: DataApi, at: DataSessionKey, source: string, sql: string, on: Outcome) => {
  const input = { source, sql, limit: RESULT_LIMIT };

  if (api.queryStream !== undefined) {
    let columns: ResultSet["columns"] = [];
    const rows: Array<ResultSet["rows"][number]> = [];

    return api.queryStream(at, input, {
      header: (header) => {
        columns = header.columns;
      },
      rows: (chunk) => {
        rows.push(...chunk);
      },
      end: ({ returned, total, truncated, elapsedMs }) =>
        on.done({ columns, rows, returned, total, truncated, elapsedMs }),
      failed: on.failed,
    });
  }

  let live = true;

  void api.query(at, input).then((result) => {
    if (!live) return;

    if (!result.ok) return on.failed(result.error);
    const { columns, rows, returned, total, truncated, elapsedMs } = result.value;

    on.done({ columns, rows, returned, total, truncated, elapsedMs });
  });

  return () => {
    live = false;
  };
};

/** Runs the tab's text on its Data Source; nothing while a run is already going (⌘↵ held). */
export const runSqlTab = (api: DataApi, at: DataSessionKey, tab: SqlTab) => {
  const { text, source, run } = read(at, tab);
  // Sent as written, so the Host's error positions line up with the editor's text.
  const sql = text;

  if (run.status === "running" || sql.trim() === "" || source === "") return;
  const id = ++runs;
  const key = keyOf(at, tab.id);
  const running: SqlRun = { status: "running", id, sql };

  patch(at, tab, { run: running, notice: null });

  const settle = (next: SqlRun) => {
    if (read(at, tab).run !== running) return;
    inFlight.delete(key);
    patch(at, tab, { run: next });
  };

  const cancel = start(api, at, source, sql, {
    done: (result) => settle({ status: "done", id, sql, result }),
    failed: (error) => settle({ status: "failed", id, sql, error, span: errorSpan(sql, error) }),
  });

  if (read(at, tab).run === running)
    inFlight.set(key, { session: dataSessionKey(at), tabId: tab.id, cancel });
};

/** The Data Source the focused SQL tab runs on; null when the focused tab isn't a SQL tab. */
export const useSqlSource = (at: DataSessionKey, active: DataTab | null): string | null =>
  useStore(sqlTabs, (all) =>
    active?.kind === "sql" ? (all[keyOf(at, active.id)]?.source ?? active.sourceId) : null
  );
