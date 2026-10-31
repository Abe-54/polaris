/**
 * The Sources tree's keyboard (WAI-ARIA tree view): ↑/↓ move, → opens or enters, ← closes or goes
 * to the parent, Home and End. Pure over the flat rows the virtualizer draws.
 */
import type { TreeRow } from "./tree.ts";

const LEVELS: Record<TreeRow["kind"], number> = {
  source: 1,
  note: 2,
  schema: 2,
  table: 3,
  functions: 3,
  function: 4,
};

export const treeLevel = (row: TreeRow) => LEVELS[row.kind];

/** A note explains, it isn't an item: the keys pass over it. */
export const focusable = (row: TreeRow) => row.kind !== "note";

const opens = (row: TreeRow) =>
  row.kind === "source" ? row.expandable : row.kind === "schema" || row.kind === "functions";

const isOpen = (row: TreeRow) => "open" in row && row.open;

export type TreeMove = { readonly focus: number } | { readonly toggle: TreeRow };

const step = (rows: ReadonlyArray<TreeRow>, from: number, by: 1 | -1): number | null => {
  for (let i = from + by; i >= 0 && i < rows.length; i += by) {
    const row = rows[i];

    if (row !== undefined && focusable(row)) return i;
  }

  return null;
};

const focus = (index: number | null): TreeMove | null => (index === null ? null : { focus: index });

const parentOf = (rows: ReadonlyArray<TreeRow>, at: number, level: number) => {
  for (let i = at - 1; i >= 0; i -= 1) {
    const row = rows[i];

    if (row !== undefined && focusable(row) && treeLevel(row) < level) return i;
  }

  return null;
};

const right = (rows: ReadonlyArray<TreeRow>, at: number, row: TreeRow): TreeMove | null => {
  if (!opens(row)) return null;

  if (!isOpen(row)) return { toggle: row };
  const next = step(rows, at, 1);
  const child = next === null ? undefined : rows[next];

  return child !== undefined && treeLevel(child) > treeLevel(row) ? focus(next) : null;
};

/** What a key does on the row at `at`; null when the tree doesn't take it. */
export const treeKey = (rows: ReadonlyArray<TreeRow>, at: number, key: string): TreeMove | null => {
  const row = rows[at];

  if (row === undefined) return null;

  switch (key) {
    case "ArrowDown":
      return focus(step(rows, at, 1));
    case "ArrowUp":
      return focus(step(rows, at, -1));
    case "Home":
      return focus(step(rows, -1, 1));
    case "End":
      return focus(step(rows, rows.length, -1));
    case "ArrowRight":
      return right(rows, at, row);
    case "ArrowLeft":
      return opens(row) && isOpen(row)
        ? { toggle: row }
        : focus(parentOf(rows, at, treeLevel(row)));
    default:
      return null;
  }
};
