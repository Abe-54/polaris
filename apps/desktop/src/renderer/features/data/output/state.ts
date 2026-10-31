/** Whether Output shows its Data tab, per Agent Session (the session's `uiKey`). */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

const shownStore = createStore<Readonly<Record<string, boolean>>>(() => ({}));

export const setDataOutputShown = (key: string, shown: boolean) =>
  shownStore.setState({ [key]: shown });

export const useDataOutputShown = (key: string) => useStore(shownStore, (s) => s[key] === true);
