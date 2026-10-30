/**
 * The data grid, shared by the Table tab and the SQL tab's results: columns, the grid, row
 * selection, CSV, and the selection's rows as a source for ⌘L.
 */
export { DataGrid, type DataGridProps, GRID_ROW } from "./DataGrid.tsx";

export { type ForeignKey, type GridColumn, isNumericType, typeLabel } from "./columns.ts";

export { toCsv } from "./csv.ts";

export { rowsBlock, rowsLabel, type RowsSource } from "./rows.ts";

export { useAddRows } from "./useAddRows.tsx";

export {
  emptySelection,
  type GridSelection,
  selectAll,
  selectCell,
  selectedRows,
} from "./selection.ts";

export {
  type Cell,
  cellOf,
  type DataRow,
  type DataValue,
  DataValueTags,
  decodeRows,
  displayOf,
} from "./value.ts";
