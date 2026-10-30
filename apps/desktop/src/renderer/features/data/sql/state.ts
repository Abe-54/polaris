/**
 * Each SQL tab's live state, kept while its tab is open so switching tabs keeps the text, the
 * chosen Data Source and the last run: the tab model holds only what the tab opened with.
 */
import type { DataValue } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { DataApi } from "../data/api.ts";
import { type DataSessionKey, dataSessionKey } from "../model/store.ts";
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
}

const IDLE: SqlRun = { status: "idle" };

const sqlTabs = createStore<Readonly<Record<string, SqlTabState>>>(() => ({}));

const keyOf = (at: DataSessionKey, tabId: string) => `${dataSessionKey(at)}\u0000${tabId}`;

const initial = (tab: SqlTab): SqlTabState => ({ text: tab.sql, source: tab.sourceId, run: IDLE });

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

export const setSqlSource = (at: DataSessionKey, tab: SqlTab, source: string) =>
  patch(at, tab, { source, run: IDLE });

let runs = 0;

/** Tabs to run once they mount: a Query Log re-run opens a tab with its query running. */
const queued = new Set<string>();

export const queueRun = (at: DataSessionKey, tabId: string) => queued.add(keyOf(at, tabId));

export const takeQueuedRun = (at: DataSessionKey, tabId: string) => queued.delete(keyOf(at, tabId));

/** Results are capped at 200 rows; the grid says when there were more. */
export const RESULT_LIMIT = 200;

/** Runs the tab's text on its Data Source; a run started later replaces this one's outcome. */
export const runSqlTab = async (api: DataApi, at: DataSessionKey, tab: SqlTab) => {
  const { text, source } = read(at, tab);
  // Sent as written, so the Host's error positions line up with the editor's text.
  const sql = text;

  if (sql.trim() === "" || source === "") return;
  const id = ++runs;
  const running: SqlRun = { status: "running", id, sql };

  patch(at, tab, { run: running });
  const result = await api.query(at, { source, sql, limit: RESULT_LIMIT });

  if (read(at, tab).run !== running) return;

  if (!result.ok) {
    patch(at, tab, {
      run: { status: "failed", id, sql, error: result.error, span: errorSpan(sql, result.error) },
    });

    return;
  }

  const { columns, rows, returned, total, truncated, elapsedMs } = result.value;

  patch(at, tab, {
    run: {
      status: "done",
      id,
      sql,
      result: { columns, rows, returned, total, truncated, elapsedMs },
    },
  });
};
