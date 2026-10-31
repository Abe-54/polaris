/**
 * Staged grid edits (DESIGN.md, Data: Table tab): cells keyed by the row's primary key and the
 * column, so they survive paging, filters and tab switches. Pure; the store holds one per tab.
 */
import type { DataEditConflict } from "@polaris/protocol";
import { Match } from "effect";
import type { DataRow, DataValue } from "../../../grid/value.ts";

/** Why the last commit refused a cell: the database holds a newer value, or the row is gone. */
export type Conflict =
  | { readonly kind: "changed"; readonly value: DataValue }
  | { readonly kind: "missing" };

export interface StagedCell {
  /** The row's primary key values, in the key's declared order. */
  readonly key: ReadonlyArray<DataValue>;
  readonly column: string;
  /** The value the grid showed before the first edit; the commit checks it is still there. */
  readonly before: DataValue;
  readonly value: DataValue;
  readonly conflict?: Conflict;
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

  if (sameValue(before, edit.value) && previous?.conflict === undefined) cells.delete(id);
  else
    cells.set(id, {
      key: edit.key,
      column: edit.column,
      before,
      value: edit.value,
      ...(previous?.conflict === undefined ? undefined : { conflict: previous.conflict }),
    });

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

export const countStaged = (staged: Pick<Staged, "cells">): StagedCount => ({
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
export const stagedRows = (staged: Pick<Staged, "cells">) => {
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
  /** The staged cells the last commit refused because the database holds a newer value. */
  readonly conflicts: ReadonlyMap<number, ReadonlySet<number>>;
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
  const conflicts = new Map<number, Set<number>>();

  const apply = (cell: StagedCell, mark: boolean) => {
    const at = index.get(rowId(cell.key));
    const col = columns.indexOf(cell.column);
    const row = at === undefined ? undefined : rows[at];

    if (at === undefined || row === undefined || col === -1) return;
    const copy = copies.get(at) ?? [...row];

    copy[col] = cell.value;
    copies.set(at, copy);

    if (mark) staged.set(at, (staged.get(at) ?? new Set()).add(col));

    if (mark && cell.conflict?.kind === "changed")
      conflicts.set(at, (conflicts.get(at) ?? new Set()).add(col));
  };

  for (const cell of layers.written) apply(cell, false);

  for (const cell of layers.staged) apply(cell, true);

  if (copies.size === 0) return { rows, staged, conflicts };

  return { rows: rows.map((row, at) => copies.get(at) ?? row), staged, conflicts };
};

/** Only these cells and their history: what a commit sent, or what's left after a drop. */
export const keepCells = (staged: Staged, keep: (cell: StagedCell) => boolean): Staged => {
  const cells = new Map([...staged.cells].filter(([, cell]) => keep(cell)));

  return { cells, history: staged.history.filter((h) => cells.has(h.id)) };
};

/** Marks the cells a commit refused (`E-DATA-CONFLICT`), so the grid and the panel show them. */
export const markConflicts = (
  staged: Staged,
  conflicts: ReadonlyArray<DataEditConflict>
): Staged => {
  const changed = new Map<string, DataValue>();
  const missing = new Set<string>();

  for (const conflict of conflicts)
    Match.valueTags(conflict, {
      Changed: (c) => void changed.set(cellId(c.key, c.column.toLowerCase()), c.value),
      Missing: (c) => void missing.add(rowId(c.key)),
    });

  const cells = new Map(staged.cells);

  for (const [id, cell] of staged.cells) {
    // MySQL names columns without regard to case, so the Daemon may spell one differently.
    const at = cellId(cell.key, cell.column.toLowerCase());

    if (missing.has(rowId(cell.key))) cells.set(id, { ...cell, conflict: { kind: "missing" } });
    else if (changed.has(at))
      cells.set(id, { ...cell, conflict: { kind: "changed", value: changed.get(at) ?? null } });
  }

  return { ...staged, cells };
};

/** Keep mine: the cell's check moves to the newer value, so the next commit writes over it. */
export const overwrite = (staged: Staged, id: string): Staged => {
  const cell = staged.cells.get(id);

  if (cell?.conflict?.kind !== "changed") return staged;
  const { conflict, ...rest } = cell;
  const cells = new Map(staged.cells);

  cells.set(id, { ...rest, before: conflict.value });

  return { ...staged, cells };
};

/** Drops one cell's edit, or every edit on a row (`rowId`). */
export const dropCells = (staged: Staged, ids: { cell?: string; row?: string }): Staged =>
  keepCells(
    staged,
    (cell) =>
      cellId(cell.key, cell.column) !== ids.cell &&
      (ids.row === undefined || rowId(cell.key) !== ids.row)
  );

/**
 * The staged cells sorted for a commit: those it sends, changed cells waiting for Overwrite or
 * Drop, rows the database no longer has, and rows not among those shown (a filter, a re-key).
 */
export const sortStaged = (staged: Staged, shown: (row: string) => boolean) => {
  const send = new Map<string, StagedCell>();
  const changed: Array<StagedCell> = [];
  const gone = new Map<string, Array<StagedCell>>();
  const hidden = new Map<string, Array<StagedCell>>();

  for (const [id, cell] of staged.cells) {
    const row = rowId(cell.key);

    if (cell.conflict?.kind === "missing") gone.set(row, [...(gone.get(row) ?? []), cell]);
    else if (!shown(row)) hidden.set(row, [...(hidden.get(row) ?? []), cell]);
    else if (cell.conflict?.kind === "changed") {
      changed.push(cell);
      send.set(id, cell);
    } else send.set(id, cell);
  }

  return { send, changed, gone, hidden };
};

export type SortedStaged = ReturnType<typeof sortStaged>;
