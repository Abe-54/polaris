/**
 * The grid's columns: name, type, the table a foreign key points at, and a width read from the
 * header and the first rows (DESIGN.md, Data: Table tab; Paper D1's widths).
 */
import { cellOf, displayOf, type DataRow } from "./value.ts";

export interface ForeignKey {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

export interface GridColumn {
  readonly name: string;
  readonly type: string;
  readonly fk?: ForeignKey | null;
}

export interface LaidColumn extends GridColumn {
  readonly width: number;
  /** Right-aligned, tabular: a numeric type, or every sampled non-NULL value a number. */
  readonly numeric: boolean;
}

const NUMERIC =
  /^(?:small|big|tiny|medium)?(?:int|integer|serial)\d?\b|^(?:numeric|decimal|real|double|float\d?|money|int[248]|float[48])\b/i;

export const isNumericType = (type: string) => NUMERIC.test(type.trim());

/** JetBrains Mono at 12px advances 7.2px a glyph; the rest keeps a full-width value from clipping. */
const CHAR_PX = 7.6;

const PAD_PX = 20;

export const MIN_WIDTH = 64;

export const MAX_WIDTH = 320;

const SAMPLE_ROWS = 100;

/** The header's second line: the type, and the referenced table for a foreign key. */
export const typeLabel = (column: GridColumn) =>
  column.fk == null ? column.type : `${column.type} → ${column.fk.table}`;

export const layColumns = (
  columns: ReadonlyArray<GridColumn>,
  rows: ReadonlyArray<DataRow>
): ReadonlyArray<LaidColumn> => {
  const sample = rows.slice(0, SAMPLE_ROWS);

  return columns.map((column, at) => {
    const typed = isNumericType(column.type);
    let chars = Math.max(column.name.length, typeLabel(column).length);
    let numbers = 0;
    let others = 0;

    for (const row of sample) {
      const cell = cellOf(row[at]);
      const extra = column.fk == null ? 0 : 2;

      chars = Math.max(chars, displayOf(cell, { numeric: typed }).length + extra);

      if (cell.kind === "number") numbers++;
      else if (cell.kind !== "null") others++;
    }

    const width = Math.round(chars * CHAR_PX + PAD_PX);

    return {
      ...column,
      width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)),
      numeric: typed || (numbers > 0 && others === 0),
    };
  });
};
