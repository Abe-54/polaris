/**
 * Each Table tab's staged edits, per Agent Session (DESIGN.md, Data: Table tab): kept outside the
 * tab so switching tabs keeps them, with the commit's progress and the values it wrote.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError } from "../../../../../../shared/api.ts";
import { type DataSessionKey, dataSessionKey } from "../../../model/store.ts";
import {
  countStaged,
  noStaged,
  type Staged,
  type StagedCell,
  type StagedCount,
  stage,
  undo,
} from "./staged.ts";

export type CommitState =
  | { readonly status: "idle" }
  | { readonly status: "confirming" }
  | { readonly status: "committing" }
  | { readonly status: "failed"; readonly error: IpcError }
  | { readonly status: "committed"; readonly count: StagedCount };

export interface TabEdits {
  readonly staged: Staged;
  /** Committed values shown until the rows are read again. */
  readonly written: ReadonlyArray<StagedCell>;
  readonly commit: CommitState;
}

const IDLE: CommitState = { status: "idle" };

export const NO_EDITS: TabEdits = { staged: noStaged, written: [], commit: IDLE };

export interface Closing {
  readonly at: DataSessionKey;
  readonly tabId: string;
}

interface State {
  readonly tabs: Readonly<Record<string, TabEdits>>;
  /** A tab with staged edits the user asked to close: the dialog asks first. */
  readonly closing: Closing | null;
}

export const editsStore = createStore<State>(() => ({ tabs: {}, closing: null }));

const keyOf = (at: DataSessionKey, tabId: string) => `${dataSessionKey(at)}\u0000${tabId}`;

export const editsOf = (at: DataSessionKey, tabId: string): TabEdits =>
  editsStore.getState().tabs[keyOf(at, tabId)] ?? NO_EDITS;

export const useTabEdits = (at: DataSessionKey, tabId: string): TabEdits =>
  useStore(editsStore, (s) => s.tabs[keyOf(at, tabId)] ?? NO_EDITS);

export const changeEdits = (
  at: DataSessionKey,
  tabId: string,
  next: (edits: TabEdits) => TabEdits
) => {
  const key = keyOf(at, tabId);

  editsStore.setState((s) => ({ tabs: { ...s.tabs, [key]: next(s.tabs[key] ?? NO_EDITS) } }));
};

/** A new edit clears the last commit's word and error. */
export const stageEdit = (at: DataSessionKey, tabId: string, edit: Parameters<typeof stage>[1]) =>
  changeEdits(at, tabId, (e) => ({
    ...e,
    staged: stage(e.staged, edit),
    commit: e.commit.status === "committing" ? e.commit : IDLE,
  }));

export const undoEdit = (at: DataSessionKey, tabId: string) =>
  changeEdits(at, tabId, (e) =>
    e.commit.status === "committing" ? e : { ...e, staged: undo(e.staged), commit: IDLE }
  );

export const discardEdits = (at: DataSessionKey, tabId: string) =>
  changeEdits(at, tabId, (e) =>
    e.commit.status === "committing" ? e : { ...e, staged: noStaged, commit: IDLE }
  );

/** The rows were read again: what was written is in them now. */
export const forgetWritten = (at: DataSessionKey, tabId: string) => {
  if (editsOf(at, tabId).written.length > 0) changeEdits(at, tabId, (e) => ({ ...e, written: [] }));
};

export const stagedCount = (at: DataSessionKey, tabId: string) =>
  countStaged(editsOf(at, tabId).staged);

/** Closing a tab drops its edits; one with staged edits asks first (`requestClose`). */
export const dropTab = (at: DataSessionKey, tabId: string) => {
  const key = keyOf(at, tabId);

  editsStore.setState((s) => {
    const { [key]: _dropped, ...tabs } = s.tabs;

    return { tabs, closing: null };
  });
};

export const askClose = (closing: Closing | null) => editsStore.setState({ closing });

export const useClosing = () => useStore(editsStore, (s) => s.closing);
