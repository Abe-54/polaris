/**
 * Each Table tab's filter and Data / Structure choice, kept while the tab is open so switching
 * tabs doesn't lose them. A foreign key sets the filter of the table it opens and keeps the one it
 * replaced, so "Back" restores it.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type DataSessionKey, dataSessionKey } from "../../model/store.ts";

export type TableViewKind = "data" | "structure";

export interface TableView {
  /** The applied filter; the well's draft lives in the well. */
  readonly filter: string;
  readonly view: TableViewKind;
  /** Filters a foreign key replaced, newest last. */
  readonly back: ReadonlyArray<string>;
}

const DEFAULT: TableView = { filter: "", view: "data", back: [] };

/** The most filters a tab remembers. */
export const BACK_LIMIT = 20;

export const tableViews = createStore<Readonly<Record<string, TableView>>>(() => ({}));

const keyOf = (at: DataSessionKey, tabId: string) => `${dataSessionKey(at)}\u0000${tabId}`;

export const useTableView = (at: DataSessionKey, tabId: string): TableView =>
  useStore(tableViews, (s) => s[keyOf(at, tabId)] ?? DEFAULT);

const change = (at: DataSessionKey, tabId: string, next: (view: TableView) => TableView) => {
  const key = keyOf(at, tabId);

  tableViews.setState((s) => ({ ...s, [key]: next(s[key] ?? DEFAULT) }));
};

export const setTableView = (
  at: DataSessionKey,
  tabId: string,
  patch: Partial<Omit<TableView, "back">>
) => change(at, tabId, (view) => ({ ...view, ...patch }));

/** A foreign key's filter, keeping the one it replaces (unless it's the same). */
export const followFilter = (at: DataSessionKey, tabId: string, filter: string) =>
  change(at, tabId, (view) =>
    view.filter === filter
      ? { ...view, view: "data" }
      : {
          filter,
          view: "data",
          back: [...view.back, view.filter].slice(-BACK_LIMIT),
        }
  );

/** The filter a foreign key replaced, applied again. */
export const filterBack = (at: DataSessionKey, tabId: string) =>
  change(at, tabId, (view) => {
    const previous = view.back.at(-1);

    return previous === undefined
      ? view
      : { ...view, filter: previous, back: view.back.slice(0, -1) };
  });
