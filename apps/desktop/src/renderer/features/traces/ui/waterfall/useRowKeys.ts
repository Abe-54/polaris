/**
 * Shared by the waterfall and Table: the density row height the virtualizer needs as a number,
 * which row holds the selected span, and Up/Down/Home/End moving the selection.
 */
import type { KeyboardEvent } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { holds, type SpanNode } from "../../model/waterfall/index.ts";

/** `--spacing-tree-row` per density step (DESIGN.md, Density). */
const TREE_ROW = { calm: 28, balanced: 24, compact: 22 } as const;

export const useTreeRowHeight = () => TREE_ROW[useApp((s) => s.density)];

export const selectedIndex = (nodes: ReadonlyArray<SpanNode>, spanId: string | null) =>
  spanId === null ? -1 : nodes.findIndex((n) => holds(n, spanId));

type Step = (at: number, count: number) => number;

const STEP = new Map<string, Step>([
  ["ArrowDown", (at) => at + 1],
  ["ArrowUp", (at) => Math.max(0, at - 1)],
  ["Home", () => 0],
  ["End", (_, count) => count - 1],
]);

/** The index a navigation key moves to, or null for any other key. */
export const movedTo = (event: KeyboardEvent, at: number, count: number): number | null => {
  const step = STEP.get(event.key);

  if (step === undefined || count === 0) return null;

  return Math.min(count - 1, step(at, count));
};
