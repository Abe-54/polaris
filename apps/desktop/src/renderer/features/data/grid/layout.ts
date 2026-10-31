/** Column widths, laid once per column set and again when the first rows arrive, never per chunk. */
import { useMemo } from "react";
import { type GridColumn, type LaidColumn, layColumns } from "./columns.ts";
import { type DataRow } from "./value.ts";

const laidFor = new WeakMap<ReadonlyArray<GridColumn>, ReadonlyArray<LaidColumn>>();

export const useLaidColumns = (
  columns: ReadonlyArray<GridColumn>,
  rows: ReadonlyArray<DataRow>
): ReadonlyArray<LaidColumn> => {
  const empty = rows.length === 0;
  const unsampled = useMemo(() => layColumns(columns, []), [columns]);

  if (empty) return unsampled;
  const laid = laidFor.get(columns) ?? layColumns(columns, rows);

  laidFor.set(columns, laid);

  return laid;
};
