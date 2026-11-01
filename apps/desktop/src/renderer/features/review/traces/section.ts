/**
 * Review's Traces section for one subject: the files list's rows, and whether the diff pane
 * shows Route timings instead of the diff.
 */
import { useMemo } from "react";
import { setTab } from "../overview/index.ts";
import { tracesListRows, type TracesListRow } from "./model.ts";
import { closeTracesCompare, openTracesCompare, useTracesCompareOpen } from "./store.ts";
import type { ReviewTraces } from "./useReviewTraces.ts";

/** The files list's Traces section: its rows, and whether the pane shows them. */
export interface FileListTraces {
  readonly rows: ReadonlyArray<TracesListRow>;
  readonly open: boolean;
  readonly onOpen: () => void;
}

export interface TracesSection {
  readonly list: FileListTraces | null;
  /** The diff pane shows Route timings. */
  readonly shown: boolean;
  /** A file or a Schema Diff opened from the list: back to it. */
  readonly closeTraces: () => void;
}

export const useTracesSection = (
  subjectKey: string,
  traces: ReviewTraces | null
): TracesSection => {
  const open = useTracesCompareOpen(subjectKey);
  const answer = traces?.answer;

  const list = useMemo<FileListTraces | null>(() => {
    const rows = answer === undefined ? [] : tracesListRows(answer);

    return rows.length === 0
      ? null
      : {
          rows,
          open,
          onOpen: () => {
            setTab(subjectKey, "changes");
            openTracesCompare(subjectKey);
          },
        };
  }, [answer, open, subjectKey]);

  return {
    list,
    shown: open && list !== null,
    closeTraces: () => closeTracesCompare(subjectKey),
  };
};
