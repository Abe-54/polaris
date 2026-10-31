/**
 * The tab's keys (DESIGN.md, Keys): ↑↓ move, ↵ focus, ←→ fold, tab next that needs you,
 * a / s accept or send back a Claim, m message the lead, / filter, esc back to the Lead.
 */
import type { RailRow } from "./rail.ts";
import type { TaskRow } from "./task.ts";

/** The keys a Task row's menu lists, as accelerators. */
export const RAIL_KEYS = { focus: "Enter", accept: "a", sendBack: "s" } as const;

export type KeyAction =
  | { readonly kind: "select"; readonly key: string }
  | { readonly kind: "focus"; readonly row: TaskRow }
  | { readonly kind: "toggle"; readonly group: string; readonly open: boolean }
  | { readonly kind: "handover"; readonly revision: number }
  | { readonly kind: "review"; readonly row: TaskRow; readonly mode: "accept" | "send-back" }
  | { readonly kind: "next-needs-you" }
  | { readonly kind: "message-lead" }
  | { readonly kind: "filter" }
  | { readonly kind: "back" };

const selectable = (row: RailRow) => row.kind !== "note";

const move = (rows: ReadonlyArray<RailRow>, at: number, step: number): KeyAction | null => {
  const keys = rows.flatMap((r) => (selectable(r) ? [r.key] : []));
  const from = at === -1 ? (step > 0 ? -1 : keys.length) : keys.indexOf(rows[at]?.key ?? "");
  const key = keys[Math.min(keys.length - 1, Math.max(0, from + step))];

  return key === undefined ? null : { kind: "select", key };
};

const enter = (row: RailRow | undefined): KeyAction | null => {
  if (row === undefined) return null;

  switch (row.kind) {
    case "task":
      return { kind: "focus", row };
    case "group":
      return { kind: "toggle", group: row.group, open: !row.open };
    case "parent":
      return { kind: "toggle", group: row.fold, open: !row.open };
    case "waiting":
      return { kind: "toggle", group: row.group, open: true };
    case "handover":
      return { kind: "handover", revision: row.handover.revision };
    case "subagent":
      return { kind: "focus", row: row.parent };
    default:
      return null;
  }
};

const depthOf = (row: RailRow | undefined) =>
  row?.kind === "task" || row?.kind === "parent" ? row.tree.depth : 0;

/** ← folds an open group or parent, or from a nested row selects the row it hangs under. */
const left = (rows: ReadonlyArray<RailRow>, at: number): KeyAction | null => {
  const row = rows[at];

  if (row?.kind === "group" && row.open) return { kind: "toggle", group: row.group, open: false };

  if (row?.kind === "parent" && row.open) return { kind: "toggle", group: row.fold, open: false };

  const depth = depthOf(row);

  if ((row?.kind !== "task" && row?.kind !== "parent") || depth === 0) return null;

  for (let i = at - 1; i >= 0; i--) {
    const above = rows[i];

    if (
      above?.kind === "group" ||
      ((above?.kind === "parent" || above?.kind === "task") && above.tree.depth < depth)
    )
      return { kind: "select", key: above.key };
  }

  return null;
};

/** → opens a folded group or parent. */
const right = (row: RailRow | undefined): KeyAction | null => {
  if (row?.kind === "group" && !row.open) return { kind: "toggle", group: row.group, open: true };

  return row?.kind === "parent" && !row.open
    ? { kind: "toggle", group: row.fold, open: true }
    : null;
};

const reviewable = (row: RailRow | undefined): row is TaskRow =>
  row?.kind === "task" && row.projection.state === "review" && row.attempt !== null;

export const railKey = (
  key: string,
  rows: ReadonlyArray<RailRow>,
  selected: string | null
): KeyAction | null => {
  const at = selected === null ? -1 : rows.findIndex((r) => r.key === selected);
  const row = rows[at];

  switch (key) {
    case "ArrowDown":
      return move(rows, at, 1);
    case "ArrowUp":
      return move(rows, at, -1);
    case RAIL_KEYS.focus:
      return enter(row);
    case "ArrowLeft":
      return left(rows, at);
    case "ArrowRight":
      return right(row);
    case "Tab":
      return { kind: "next-needs-you" };
    case RAIL_KEYS.accept:
      return reviewable(row) ? { kind: "review", row, mode: "accept" } : null;
    case RAIL_KEYS.sendBack:
      return reviewable(row) ? { kind: "review", row, mode: "send-back" } : null;
    case "m":
      return { kind: "message-lead" };
    case "/":
      return { kind: "filter" };
    case "Escape":
      return { kind: "back" };
    default:
      return null;
  }
};
