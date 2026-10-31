/**
 * One tab stop for the Sources tree (a roving tabindex): the focused row, else the open table's,
 * else the first. Keys move focus through `treeKey`, scrolling the virtualized row into view.
 */
import type { Virtualizer } from "@tanstack/react-virtual";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";
import type { TreeRow } from "../../model/tree.ts";
import { focusable, treeKey } from "../../model/treeKeys.ts";

const rowElement = (scroller: HTMLElement | null, key: string): HTMLElement | null => {
  for (const el of scroller?.querySelectorAll<HTMLElement>("[data-tree-key]") ?? [])
    if (el.dataset.treeKey === key) return el;

  return null;
};

const keyOf = (target: EventTarget) =>
  target instanceof HTMLElement
    ? (target.closest<HTMLElement>("[data-tree-key]")?.dataset.treeKey ?? null)
    : null;

export const useTreeFocus = ({
  rows,
  selected,
  scroller,
  virtualizer,
  onToggle,
}: {
  readonly rows: ReadonlyArray<TreeRow>;
  /** The open table's row key, the tab stop until the user moves it. */
  readonly selected: string | null;
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly virtualizer: Virtualizer<HTMLDivElement, Element>;
  readonly onToggle: (row: TreeRow) => void;
}) => {
  const [focused, setFocused] = useState<string | null>(null);
  const pending = useRef<string | null>(null);

  const has = (key: string | null) =>
    key !== null && rows.some((r) => r.key === key && focusable(r));

  const tabStop = [focused, selected].find(has) ?? rows.find(focusable)?.key ?? null;

  // A row scrolled into view mounts on a later render; focus it once it's there.
  useEffect(() => {
    const key = pending.current;
    const el = key === null ? null : rowElement(scroller.current, key);

    if (el === null) return;
    pending.current = null;
    el.focus();
  });

  const onKeyDown = (event: KeyboardEvent) => {
    const key = keyOf(event.target);
    const at = rows.findIndex((r) => r.key === key);
    const move = at === -1 ? null : treeKey(rows, at, event.key);

    if (move === null) return;
    event.preventDefault();

    if ("toggle" in move) return onToggle(move.toggle);
    const next = rows[move.focus];

    if (next === undefined) return;
    pending.current = next.key;
    setFocused(next.key);
    virtualizer.scrollToIndex(move.focus);
  };

  const onFocus = (event: { readonly target: EventTarget }) => {
    const key = keyOf(event.target);

    if (key !== null) setFocused(key);
  };

  return { tabStop, onKeyDown, onFocus };
};
