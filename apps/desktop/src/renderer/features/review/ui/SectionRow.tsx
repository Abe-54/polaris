/**
 * The files list's Agent Session sections after the migrations: Data's rows, then Traces'
 * (DESIGN.md, Data → In Review; Traces → In Review). Both lists place and render them alike.
 */
import { DataRow } from "../schema/DataRows.tsx";
import { type DataListRow, isDataRow } from "../schema/model.ts";
import { isTracesRow, type TracesListRow } from "../traces/model.ts";
import type { FileListTraces } from "../traces/section.ts";
import { TracesRow } from "../traces/TracesRows.tsx";
import type { FileListData } from "./FileList.tsx";

export type SectionListRow = DataListRow | TracesListRow;

export const isSectionRow = (row: { readonly kind: string }): row is SectionListRow =>
  isDataRow(row) || isTracesRow(row);

export const sectionRows = (
  data: FileListData | null,
  traces: FileListTraces | null
): ReadonlyArray<SectionListRow> => [...(data?.rows ?? []), ...(traces?.rows ?? [])];

export const SectionRow = ({
  row,
  data,
  traces,
}: {
  readonly row: SectionListRow;
  readonly data: FileListData | null;
  readonly traces: FileListTraces | null;
}) => {
  if (isTracesRow(row))
    return traces === null ? null : (
      <TracesRow row={row} open={traces.open} onOpen={traces.onOpen} />
    );

  return data === null ? null : <DataRow row={row} open={data.open} onOpen={data.onOpen} />;
};
