/**
 * Row selection and the active cell: click selects one row, ⇧-click a range from the anchor,
 * ⌘-click toggles one, arrows move the active cell. Pure, so the grid and tests share it.
 */

export interface CellAt {
  readonly row: number;
  readonly col: number;
}

export interface GridSelection {
  /** Selected row indexes, in the order the grid shows them. */
  readonly rows: ReadonlySet<number>;
  readonly anchor: number | null;
  readonly active: CellAt | null;
}

export const emptySelection: GridSelection = { rows: new Set(), anchor: null, active: null };

export interface Modifiers {
  readonly range?: boolean;
  readonly toggle?: boolean;
}

const range = (from: number, to: number) => {
  const rows = new Set<number>();

  for (let at = Math.min(from, to); at <= Math.max(from, to); at++) rows.add(at);

  return rows;
};

export const selectCell = (
  selection: GridSelection,
  cell: CellAt,
  { range: extend = false, toggle = false }: Modifiers = {}
): GridSelection => {
  if (extend && selection.anchor !== null)
    return { ...selection, rows: range(selection.anchor, cell.row), active: cell };

  if (toggle) {
    const rows = new Set(selection.rows);

    if (rows.has(cell.row)) rows.delete(cell.row);
    else rows.add(cell.row);

    return { rows, anchor: cell.row, active: cell };
  }

  return { rows: new Set([cell.row]), anchor: cell.row, active: cell };
};

export const selectAll = (selection: GridSelection, rowCount: number): GridSelection =>
  rowCount === 0 ? selection : { ...selection, rows: range(0, rowCount - 1), anchor: 0 };

export type Move = "up" | "down" | "left" | "right" | "home" | "end";

const clamp = (value: number, max: number) => Math.max(0, Math.min(max, value));

/** Moves the active cell, selecting its row (extending with ⇧). */
export const moveActive = (
  selection: GridSelection,
  move: Move,
  size: { readonly rows: number; readonly cols: number },
  modifiers: Modifiers = {}
): GridSelection => {
  if (size.rows === 0 || size.cols === 0) return selection;
  const { row, col } = selection.active ?? { row: -1, col: 0 };

  const next: Record<Move, CellAt> = {
    up: { row: row - 1, col },
    down: { row: row + 1, col },
    left: { row, col: col - 1 },
    right: { row, col: col + 1 },
    home: { row: 0, col },
    end: { row: size.rows - 1, col },
  };

  const target = next[move];

  return selectCell(
    selection,
    { row: clamp(target.row, size.rows - 1), col: clamp(target.col, size.cols - 1) },
    { range: modifiers.range ?? false }
  );
};

/** The selected rows' indexes in ascending order. */
export const selectedRows = (selection: GridSelection): ReadonlyArray<number> =>
  [...selection.rows].sort((a, b) => a - b);
