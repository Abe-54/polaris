/** Whether Output shows its Traces tab, per Agent Session (the session's `uiKey`). */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

const shownStore = createStore<Readonly<Record<string, boolean>>>(() => ({}));

export const setTracesOutputShown = (key: string, shown: boolean) =>
  shownStore.setState({ [key]: shown });

export const useTracesOutputShown = (key: string) => useStore(shownStore, (s) => s[key] === true);
