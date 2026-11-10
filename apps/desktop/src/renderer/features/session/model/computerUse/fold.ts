/**
 * Folds a Turn's computer use calls, which keep their own item rows in `groupFlow`, into one
 * desktop entry per app; finished thinking between two calls folds in with them.
 */
import type { ItemView } from "../items.ts";
import type { Entry } from "../runs.ts";
import { type DesktopItem, desktopRun, isDesktopItem, splitRuns } from "./index.ts";

export type { DesktopRun } from "./index.ts";

const finishedThinking = (entry: Entry) =>
  entry.kind === "item" && entry.item.kind === "reasoning" && !entry.item.live;

/** Each run's items: its calls with the thinking that came between them. */
const withThinking = (
  calls: ReadonlyArray<DesktopItem>,
  all: ReadonlyArray<ItemView>
): ReadonlyArray<ItemView> => {
  const first = calls[0];
  const last = calls.at(-1);

  if (first === undefined || last === undefined) return calls;

  return all.slice(all.indexOf(first), all.indexOf(last) + 1);
};

export const foldDesktop = (entries: ReadonlyArray<Entry>): ReadonlyArray<Entry> => {
  const out: Array<Entry> = [];
  let calls: Array<DesktopItem> = [];
  let pending: Array<ItemView> = [];
  let held: Array<Entry> = [];

  const flush = () => {
    for (const run of splitRuns(calls))
      out.push({
        kind: "desktop",
        id: run[0].id,
        items: withThinking(run, pending),
        run: desktopRun(run),
      });
    out.push(...held);
    calls = [];
    pending = [];
    held = [];
  };

  for (const entry of entries) {
    if (entry.kind === "item" && isDesktopItem(entry.item)) {
      pending.push(...held.flatMap((h) => (h.kind === "item" ? [h.item] : [])), entry.item);
      held = [];
      calls.push(entry.item);
    } else if (calls.length > 0 && finishedThinking(entry)) held.push(entry);
    else {
      flush();
      out.push(entry);
    }
  }

  flush();

  return out;
};
