/**
 * Each Table tab's filter and Data / Structure choice, kept while the tab is open so switching
 * tabs doesn't lose them. A foreign key sets the filter of the table it opens.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type DataSessionKey, dataSessionKey } from "../../model/store.ts";

export type TableViewKind = "data" | "structure";

export interface TableView {
  /** The applied filter; the well's draft lives in the well. */
  readonly filter: string;
  readonly view: TableViewKind;
}

const DEFAULT: TableView = { filter: "", view: "data" };

export const tableViews = createStore<Readonly<Record<string, TableView>>>(() => ({}));

const keyOf = (at: DataSessionKey, tabId: string) => `${dataSessionKey(at)}\u0000${tabId}`;

export const useTableView = (at: DataSessionKey, tabId: string): TableView =>
  useStore(tableViews, (s) => s[keyOf(at, tabId)] ?? DEFAULT);

export const setTableView = (at: DataSessionKey, tabId: string, patch: Partial<TableView>) => {
  const key = keyOf(at, tabId);

  tableViews.setState((s) => ({ ...s, [key]: { ...(s[key] ?? DEFAULT), ...patch } }));
};
