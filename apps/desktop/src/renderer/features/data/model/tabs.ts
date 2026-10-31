/**
 * Data's open tabs per Agent Session (DESIGN.md, Data): a Table tab per table and any number of
 * SQL tabs. Pure transitions, so the store and the tests share them.
 */
import type { DataValue } from "@polaris/protocol";

export type DataTab =
  | {
      readonly kind: "table";
      readonly id: string;
      /** The Data Source's `name`, as the Data RPCs take it. */
      readonly sourceId: string;
      readonly table: string;
    }
  | {
      readonly kind: "sql";
      readonly id: string;
      readonly sourceId: string;
      readonly sql: string;
      /** Bound to `$1`, `$2`… on Run: a Query Log re-run keeps the params the query ran with. */
      readonly params: ReadonlyArray<DataValue>;
      /** "Query 1", "Query 2"…, numbered per session and never reused. */
      readonly title: string;
      /** Shown over the editor until the next run, e.g. why a re-run didn't run. */
      readonly notice?: string;
    };

export type DataTabKind = DataTab["kind"];

export interface DataTabs {
  readonly tabs: ReadonlyArray<DataTab>;
  readonly active: string | null;
  /** The next SQL tab's number. */
  readonly nextQuery: number;
}

export const emptyTabs: DataTabs = { tabs: [], active: null, nextQuery: 1 };

export const tableTabId = (sourceId: string, table: string) =>
  `table\u0000${sourceId}\u0000${table}`;

/** Focuses the table's tab, opening it after the active one when it isn't open yet. */
export const openTable = (state: DataTabs, sourceId: string, table: string): DataTabs => {
  const id = tableTabId(sourceId, table);

  if (state.tabs.some((t) => t.id === id)) return { ...state, active: id };

  return insertAfterActive(state, { kind: "table", id, sourceId, table });
};

/** Always a new SQL tab, focused: a re-run from the Query Log never overwrites one being edited. */
export const openSqlTab = (
  state: DataTabs,
  sql: string,
  sourceId: string,
  params: ReadonlyArray<DataValue> = [],
  notice?: string
): DataTabs => {
  const n = state.nextQuery;
  const id = `sql\u0000${n}`;
  const opened = { kind: "sql", id, sourceId, sql, params, title: `Query ${n}` } as const;
  const tab: DataTab = notice === undefined ? opened : { ...opened, notice };

  return { ...insertAfterActive(state, tab), nextQuery: n + 1 };
};

export const focusTab = (state: DataTabs, id: string): DataTabs =>
  state.tabs.some((t) => t.id === id) ? { ...state, active: id } : state;

/** Closing the active tab focuses its right neighbour, else its left. */
export const closeTab = (state: DataTabs, id: string): DataTabs => {
  const at = state.tabs.findIndex((t) => t.id === id);

  if (at === -1) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);

  if (state.active !== id) return { ...state, tabs };

  return { ...state, tabs, active: (tabs[at] ?? tabs[at - 1])?.id ?? null };
};

const insertAfterActive = (state: DataTabs, tab: DataTab): DataTabs => {
  const at = state.tabs.findIndex((t) => t.id === state.active);
  const tabs = [...state.tabs];

  tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab);

  return { ...state, tabs, active: tab.id };
};
