/**
 * The tab store: each Agent Session's tabs, and which session Data shows. `openTable` and
 * `openSqlTab` act on the shown session unless given one, so "Open in Data" can target any.
 */
import type { DataValue, SessionId } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import * as tabs from "./tabs.ts";

export interface DataSessionKey {
  readonly hostKey: string;
  readonly sessionId: SessionId;
}

export const dataSessionKey = ({ hostKey, sessionId }: DataSessionKey) =>
  `${hostKey}\u0000${sessionId}`;

interface State {
  readonly sessions: Readonly<Record<string, tabs.DataTabs>>;
  /** The session Data mode is showing; null while it shows none. */
  readonly shown: string | null;
}

export const dataTabsStore = createStore<State>(() => ({ sessions: {}, shown: null }));

const update = (
  at: DataSessionKey | undefined,
  change: (state: tabs.DataTabs) => tabs.DataTabs
) => {
  const { sessions, shown } = dataTabsStore.getState();
  const key = at === undefined ? shown : dataSessionKey(at);

  if (key === null) return;
  dataTabsStore.setState({
    sessions: { ...sessions, [key]: change(sessions[key] ?? tabs.emptyTabs) },
  });
};

/** Data mode reports the session it shows; the tab actions default to it. */
export const showDataSession = (at: DataSessionKey | null) =>
  dataTabsStore.setState({ shown: at === null ? null : dataSessionKey(at) });

export const openTable = (
  sourceId: string,
  ref: tabs.TableRef,
  at?: DataSessionKey,
  title?: string
) => update(at, (s) => tabs.openTable(s, sourceId, ref, title));

export const openSqlTab = (
  sql: string,
  sourceId: string,
  at?: DataSessionKey,
  params: ReadonlyArray<DataValue> = []
) => update(at, (s) => tabs.openSqlTab(s, sql, sourceId, params));

export const focusDataTab = (id: string, at?: DataSessionKey) =>
  update(at, (s) => tabs.focusTab(s, id));

export const closeDataTab = (id: string, at?: DataSessionKey) =>
  update(at, (s) => tabs.closeTab(s, id));

export const useDataTabs = (at: DataSessionKey): tabs.DataTabs =>
  useStore(dataTabsStore, (s) => s.sessions[dataSessionKey(at)] ?? tabs.emptyTabs);
