/** The sidebar's view (`Sources | Query log`) and the tree rows the user toggled, per Agent Session. */
import type { DataSource } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type DataSessionKey, dataSessionKey } from "./store.ts";

export type SidebarView = "sources" | "log";

export interface SidebarState {
  readonly view: SidebarView;
  readonly toggled: ReadonlyMap<string, boolean>;
}

const EMPTY: SidebarState = { view: "sources", toggled: new Map() };

export const sidebarStore = createStore<Readonly<Record<string, SidebarState>>>(() => ({}));

const patch = (at: DataSessionKey, change: (state: SidebarState) => SidebarState) => {
  const key = dataSessionKey(at);

  sidebarStore.setState({ [key]: change(sidebarStore.getState()[key] ?? EMPTY) });
};

export const setSidebarView = (at: DataSessionKey, view: SidebarView) =>
  patch(at, (s) => ({ ...s, view }));

/** Opens or closes a tree row; `open` is what it shows now. */
export const toggleTreeRow = (at: DataSessionKey, key: string, open: boolean) =>
  patch(at, (s) => ({ ...s, toggled: new Map(s.toggled).set(key, !open) }));

export const useSidebar = (at: DataSessionKey): SidebarState =>
  useStore(sidebarStore, (s) => s[dataSessionKey(at)] ?? EMPTY);

/** The manual source form: closed, adding a new source, or editing one the user added. */
export type SourceForm =
  | { readonly mode: "add" }
  | { readonly mode: "edit"; readonly source: DataSource };

/** Per Agent Session, so a form left open never saves into another session's checkout. */
const formStore = createStore<Readonly<Record<string, SourceForm>>>(() => ({}));

export const openSourceForm = (at: DataSessionKey, form: SourceForm) =>
  formStore.setState({ [dataSessionKey(at)]: form });

export const closeSourceForm = (at: DataSessionKey) => {
  const { [dataSessionKey(at)]: _closed, ...rest } = formStore.getState();

  formStore.setState(rest, true);
};

export const useSourceForm = (at: DataSessionKey): SourceForm | null =>
  useStore(formStore, (s) => s[dataSessionKey(at)] ?? null);
