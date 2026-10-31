/**
 * Each Table tab's staged edits, per Agent Session (DESIGN.md, Data: Table tab): kept outside the
 * tab so switching tabs keeps them, with the commit's progress and the values it wrote. The shelf
 * (`connectShelf`) keeps them across a reload or quit.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError } from "../../../../../../shared/api.ts";
import { type DataSessionKey, dataSessionKey } from "../../../model/store.ts";
import { readShelf, writeShelf } from "./shelf.ts";
import {
  countStaged,
  dropCells,
  noStaged,
  overwrite,
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
  /** A tab with staged edits (or a commit on its way) the user asked to close: a dialog first. */
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

/** As `changeEdits`, but a tab that was closed meanwhile stays closed (a commit's late answer). */
export const changeOpenEdits = (
  at: DataSessionKey,
  tabId: string,
  next: (edits: TabEdits) => TabEdits
) => {
  const key = keyOf(at, tabId);

  editsStore.setState((s) => {
    const edits = s.tabs[key];

    return edits === undefined ? s : { tabs: { ...s.tabs, [key]: next(edits) } };
  });
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

/** Changes the staged set unless a commit is on its way, clearing the last commit's word. */
const restage = (at: DataSessionKey, tabId: string, next: (staged: Staged) => Staged) =>
  changeEdits(at, tabId, (e) =>
    e.commit.status === "committing" ? e : { ...e, staged: next(e.staged), commit: IDLE }
  );

/** Drops every staged edit, returning them so Undo can put them back. */
export const discardEdits = (at: DataSessionKey, tabId: string): Staged => {
  const { staged, commit } = editsOf(at, tabId);

  if (commit.status === "committing") return noStaged;
  restage(at, tabId, () => noStaged);

  return staged;
};

/** Undo after Discard: the discarded edits come back, under any staged since. */
export const restoreEdits = (at: DataSessionKey, tabId: string, discarded: Staged) =>
  restage(at, tabId, (now) => ({
    cells: new Map([...discarded.cells, ...now.cells]),
    history: [...discarded.history, ...now.history],
  }));

/** A conflict's Overwrite: the next commit writes over the newer value. */
export const overwriteEdit = (at: DataSessionKey, tabId: string, ids: ReadonlyArray<string>) =>
  restage(at, tabId, (staged) => ids.reduce(overwrite, staged));

/** A conflict's or hidden row's Drop edit: one cell, or every cell on the row. */
export const dropEdit = (
  at: DataSessionKey,
  tabId: string,
  ids: ReadonlyArray<{ cell?: string; row?: string }>
) => restage(at, tabId, (staged) => ids.reduce(dropCells, staged));

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

/** How long the shelf waits after the last change before it saves. */
const SHELF_DELAY_MS = 300;

/**
 * Restores the shelf's staged edits and keeps it up to date; a window closing saves at once.
 * Returns the disconnect.
 */
export const connectShelf = (storage: Storage | null, target: EventTarget | null = null) => {
  const restored = readShelf(storage);
  const savedAt = new Map(Object.entries(restored).map(([key, r]) => [key, r.savedAt]));

  editsStore.setState((s) => ({
    tabs: {
      ...Object.fromEntries(
        Object.entries(restored).map(([key, r]) => [key, { ...NO_EDITS, staged: r.staged }])
      ),
      ...s.tabs,
    },
  }));

  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    const { tabs } = editsStore.getState();

    writeShelf(
      storage,
      Object.fromEntries(
        Object.entries(tabs).map(([key, tab]) => [
          key,
          { staged: tab.staged, savedAt: savedAt.get(key) ?? 0 },
        ])
      )
    );
  };

  const unsubscribe = editsStore.subscribe((state, previous) => {
    const now = Date.now();

    for (const [key, tab] of Object.entries(state.tabs))
      if (previous.tabs[key]?.staged !== tab.staged) savedAt.set(key, now);
    clearTimeout(timer);
    timer = setTimeout(save, SHELF_DELAY_MS);
  });

  target?.addEventListener("pagehide", save);

  return () => {
    if (timer !== undefined) save();
    unsubscribe();
    target?.removeEventListener("pagehide", save);
  };
};

let opened = false;

/** The window's shelf, connected once, the first time Data mode loads. */
export const openEditsShelf = () => {
  if (opened) return;
  opened = true;
  let storage: Storage | null = null;

  try {
    storage = window.localStorage;
  } catch {
    // Storage off: edits last for this launch.
  }

  connectShelf(storage, window);
};
