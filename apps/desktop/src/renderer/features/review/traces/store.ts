/**
 * Whether the diff pane shows the Route timings body, per Review subject. It and a Schema
 * Diff take the pane in turn: opening one closes the other.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { closeSchemaDiff, schemaPaneStore } from "../schema/store.ts";

export const tracesPaneStore = createStore<{
  /** Subject keys whose diff pane shows Route timings. */
  readonly open: ReadonlySet<string>;
}>(() => ({ open: new Set() }));

export const closeTracesCompare = (subjectKey: string) =>
  tracesPaneStore.setState((s) => {
    if (!s.open.has(subjectKey)) return s;
    const open = new Set(s.open);

    open.delete(subjectKey);

    return { open };
  });

export const openTracesCompare = (subjectKey: string) => {
  closeSchemaDiff(subjectKey);
  tracesPaneStore.setState((s) =>
    s.open.has(subjectKey) ? s : { open: new Set([...s.open, subjectKey]) }
  );
};

// A Schema Diff opened from anywhere (the files list, a migration's header) takes the pane.
schemaPaneStore.subscribe((now, before) => {
  for (const [key, source] of Object.entries(now.open))
    if (before.open[key] !== source) closeTracesCompare(key);
});

export const useTracesCompareOpen = (subjectKey: string) =>
  useStore(tracesPaneStore, (s) => s.open.has(subjectKey));
