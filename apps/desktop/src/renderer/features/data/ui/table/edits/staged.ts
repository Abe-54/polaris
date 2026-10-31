/**
 * Staged grid edits (DESIGN.md, Data: Table tab): cells keyed by the row's primary key and the
 * column, so they survive paging, filters and tab switches. Pure; the store holds one per tab.
 */
import type { DataRow, DataValue } from "../../../grid/value.ts";

export interface StagedCell {
  /** The row's primary key values, in the key's column order. */
  readonly key: ReadonlyArray<DataValue>;
  readonly column: string;
  /** The value the grid showed before the first edit. */
  readonly before: DataValue;
  readonly value: DataValue;
}

export interface Staged {
  readonly cells: ReadonlyMap<string, StagedCell>;
  /** Each edit's cell and what it replaced, newest last, for ⌘Z. */
  readonly history: ReadonlyArray<{ readonly id: string; readonly previous: StagedCell | null }>;
}

export const noStaged: Staged = { cells: new Map(), history: [] };

/** The most edits one commit carries (`data.edits.commit`). */
export const MAX_EDITS = 10_000;

export const rowId = (key: ReadonlyArray<DataValue>) => JSON.stringify(key);

export const cellId = (key: ReadonlyArray<DataValue>, column: string) =>
  JSON.stringify([key, column]);

export const sameValue = (a: DataValue, b: DataValue) => JSON.stringify(a) === JSON.stringify(b);

/** Stages `value`; setting a cell back to what it was unstages it. */
export const stage = (
  staged: Staged,
  edit: {
    readonly key: ReadonlyArray<DataValue>;
    readonly column: string;
    readonly before: DataValue;
    readonly value: DataValue;
  }
): Staged => {
  const id = cellId(edit.key, edit.column);
  const previous = staged.cells.get(id) ?? null;
  const before = previous?.before ?? edit.before;

  if (previous !== null && sameValue(previous.value, edit.value)) return staged;

  if (previous === null && sameValue(before, edit.value)) return staged;
  const cells = new Map(staged.cells);

  if (sameValue(before, edit.value)) cells.delete(id);
  else cells.set(id, { key: edit.key, column: edit.column, before, value: edit.value });

  return { cells, history: [...staged.history, { id, previous }] };
};

/** Takes back the last edit, restoring what that cell held before it. */
export const undo = (staged: Staged): Staged => {
  const last = staged.history.at(-1);

  if (last === undefined) return staged;
  const cells = new Map(staged.cells);

  if (last.previous === null) cells.delete(last.id);
  else cells.set(last.id, last.previous);

  return { cells, history: staged.history.slice(0, -1) };
};

export interface StagedCount {
  readonly changes: number;
  readonly rows: number;
}

export const countStaged = (staged: Staged): StagedCount => ({
  changes: staged.cells.size,
  rows: new Set([...staged.cells.values()].map((c) => rowId(c.key))).size,
});

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** "1 change staged · 1 row", "3 changes staged · 2 rows". */
export const stagedLabel = ({ changes, rows }: StagedCount) =>
  `${plural(changes, "change", "changes")} staged · ${plural(rows, "row", "rows")}`;

/** "1 change · 1 row", after a commit. */
export const changesLabel = ({ changes, rows }: StagedCount) =>
  `${plural(changes, "change", "changes")} · ${plural(rows, "row", "rows")}`;

/** The staged cells grouped by row, in the order each row was first staged. */
export const stagedRows = (staged: Staged) => {
  const rows = new Map<string, { key: ReadonlyArray<DataValue>; cells: Array<StagedCell> }>();

  for (const cell of staged.cells.values()) {
    const id = rowId(cell.key);
    const row = rows.get(id) ?? { key: cell.key, cells: [] };

    row.cells.push(cell);
    rows.set(id, row);
  }

  return [...rows.values()];
};

/** Each row's index in `rows` by its key, built once per page set. */
export const keyIndex = (rows: ReadonlyArray<DataRow>, keyCols: ReadonlyArray<number>) => {
  const index = new Map<string, number>();

  rows.forEach((row, at) => index.set(rowId(keyCols.map((c) => row[c] ?? null)), at));

  return index;
};

export interface Overlay {
  readonly rows: ReadonlyArray<DataRow>;
  /** Staged cells by row index, then column index. */
  readonly staged: ReadonlyMap<number, ReadonlySet<number>>;
}

/**
 * The rows as the grid shows them: `written` values (committed, not yet re-read) then staged
 * ones over the fetched rows. Only rows with a change are copied.
 */
export const overlay = (
  rows: ReadonlyArray<DataRow>,
  columns: ReadonlyArray<string>,
  index: ReadonlyMap<string, number>,
  layers: { readonly written: Iterable<StagedCell>; readonly staged: Iterable<StagedCell> }
): Overlay => {
  const copies = new Map<number, Array<DataValue>>();
  const staged = new Map<number, Set<number>>();

  const apply = (cell: StagedCell, mark: boolean) => {
    const at = index.get(rowId(cell.key));
    const col = columns.indexOf(cell.column);
    const row = at === undefined ? undefined : rows[at];

    if (at === undefined || row === undefined || col === -1) return;
    const copy = copies.get(at) ?? [...row];

    copy[col] = cell.value;
    copies.set(at, copy);

    if (mark) staged.set(at, (staged.get(at) ?? new Set()).add(col));
  };

  for (const cell of layers.written) apply(cell, false);

  for (const cell of layers.staged) apply(cell, true);

  if (copies.size === 0) return { rows, staged };

  return { rows: rows.map((row, at) => copies.get(at) ?? row), staged };
};
