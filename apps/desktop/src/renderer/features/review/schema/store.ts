/**
 * Which Data Source's Schema Diff the diff pane shows, per Review subject, and the link a
 * migration file's header offers to it. A file opened from the list returns to the diff.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export const schemaPaneStore = createStore<{
  /** The open source's id by subject key; absent while the diff shows. */
  readonly open: Readonly<Record<string, string>>;
  /** The first source with changes in the Review on screen, for a migration's "Schema diff". */
  readonly link: { readonly subjectKey: string; readonly sourceId: string } | null;
}>(() => ({ open: {}, link: null }));

export const openSchemaDiff = (subjectKey: string, sourceId: string) =>
  schemaPaneStore.setState((s) => ({ open: { ...s.open, [subjectKey]: sourceId } }));

export const closeSchemaDiff = (subjectKey: string) =>
  schemaPaneStore.setState((s) => {
    if (s.open[subjectKey] === undefined) return s;
    const { [subjectKey]: _, ...open } = s.open;

    return { open };
  });

export const setSchemaLink = (
  link: { readonly subjectKey: string; readonly sourceId: string } | null
) =>
  schemaPaneStore.setState((s) =>
    s.link?.subjectKey === link?.subjectKey && s.link?.sourceId === link?.sourceId ? s : { link }
  );

export const useOpenSchema = (subjectKey: string) =>
  useStore(schemaPaneStore, (s) => s.open[subjectKey] ?? null);

export const useSchemaLink = () => useStore(schemaPaneStore, (s) => s.link);
