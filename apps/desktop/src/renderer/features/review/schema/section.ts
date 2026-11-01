/**
 * Review's Data section for one subject: the files list's rows, the source the diff pane
 * shows, and the migration headers' "Schema diff" link while the Review is on screen.
 */
import type { SchemaSourceDiff } from "@polaris/protocol";
import type { TableRef } from "../../data/model/tabs.ts";
import { useEffect, useMemo } from "react";
import { setTab } from "../overview/index.ts";
import type { FileListData } from "../ui/FileList.tsx";
import type { PrunedNote } from "./copy.ts";
import { dataListRows } from "./model.ts";
import { closeSchemaDiff, openSchemaDiff, setSchemaLink, useOpenSchema } from "./store.ts";

/** What an Agent Session's Review knows of its Schema Diff. */
export interface ReviewSchema {
  /** Sources the Review shows (`shownSources`); empty hides the section. */
  readonly sources: ReadonlyArray<SchemaSourceDiff>;
  /** "start → end of turn 7", "across this session". */
  readonly scope: string;
  /** The Turn picked; undefined across the session. */
  readonly turn: string | undefined;
  /** A Turn id's number as the Review shows it, for a carried baseline's "Since turn 4". */
  readonly turnNumber: (turn: string) => number | undefined;
  /** Said when retention dropped the history asked for (`prunedNote`). */
  readonly pruned: PrunedNote | null;
  /** Opens a table in Data (⌘4). */
  readonly onOpenTable: (source: SchemaSourceDiff, table: TableRef) => void;
}

export interface SchemaSection {
  readonly data: FileListData | null;
  /** The source the diff pane shows instead of the files; null shows the diff. */
  readonly shown: SchemaSourceDiff | null;
  /** A file opened from the list: back to the diff. */
  readonly closeSchema: () => void;
}

export const useSchemaSection = (
  subjectKey: string,
  schema: ReviewSchema | null
): SchemaSection => {
  const open = useOpenSchema(subjectKey);
  const sources = schema?.sources;
  const pruned = schema?.pruned ?? null;
  const first = sources?.[0]?.source.id ?? null;

  useEffect(() => {
    setSchemaLink(first === null ? null : { subjectKey, sourceId: first });

    return () => setSchemaLink(null);
  }, [subjectKey, first]);

  const data = useMemo<FileListData | null>(
    () =>
      sources === undefined || (sources.length === 0 && pruned === null)
        ? null
        : {
            rows: dataListRows(sources, pruned),
            open,
            onOpen: (sourceId) => {
              setTab(subjectKey, "changes");
              openSchemaDiff(subjectKey, sourceId);
            },
          },
    [sources, pruned, open, subjectKey]
  );

  return {
    data,
    shown: sources?.find((s) => s.source.id === open) ?? null,
    closeSchema: () => closeSchemaDiff(subjectKey),
  };
};
