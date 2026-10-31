/**
 * Staged edits kept in this window's `localStorage` (DESIGN.md, Data: Table tab), per Agent
 * Session and Table tab, so a reload or quit doesn't lose them. Bounded; the commit re-checks.
 */
import { DataValue } from "@polaris/protocol";
import { Option, Schema } from "effect";
import { cellId, type Staged, type StagedCell } from "./staged.ts";

const KEY = "polaris.data.staged.v1";

/** The most the shelf holds; the oldest tabs leave first past it. */
export const SHELF_BYTES = 2_000_000;

const Cell = Schema.Struct({
  key: Schema.Array(DataValue),
  column: Schema.String,
  before: DataValue,
  value: DataValue,
  conflict: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("changed"), value: DataValue }),
      Schema.Struct({ kind: Schema.Literal("missing") }),
    ])
  ),
});

const Stored = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Struct({ savedAt: Schema.Number, cells: Schema.Array(Cell) }))
);

type Shelf = typeof Stored.Type;

/** Each tab's staged cells as last saved; a damaged or foreign shelf reads as empty. */
export const readShelf = (
  storage: Storage | null
): Record<string, { readonly staged: Staged; readonly savedAt: number }> => {
  let raw: string | null = null;

  try {
    raw = storage?.getItem(KEY) ?? null;
  } catch {
    return {};
  }

  const shelf: Shelf = Option.getOrElse(
    Schema.decodeUnknownOption(Stored)(raw ?? "{}"),
    () => ({})
  );

  return Object.fromEntries(
    Object.entries(shelf).map(([tab, saved]) => [
      tab,
      {
        savedAt: saved.savedAt,
        staged: {
          cells: new Map(saved.cells.map((c) => [cellId(c.key, c.column), c])),
          history: [],
        },
      },
    ])
  );
};

/** Saves every tab with staged cells, newest first, until the shelf is full. */
export const writeShelf = (
  storage: Storage | null,
  tabs: Readonly<Record<string, { readonly staged: Staged; readonly savedAt: number }>>
) => {
  const entries = Object.entries(tabs)
    .filter(([, tab]) => tab.staged.cells.size > 0)
    .toSorted(([, a], [, b]) => b.savedAt - a.savedAt);

  const kept: Record<string, { savedAt: number; cells: ReadonlyArray<StagedCell> }> = {};
  let bytes = 2;

  for (const [tab, { staged, savedAt }] of entries) {
    const entry = { savedAt, cells: [...staged.cells.values()] };
    const size = JSON.stringify(tab).length + JSON.stringify(entry).length + 2;

    if (bytes + size > SHELF_BYTES) continue;
    kept[tab] = entry;
    bytes += size;
  }

  try {
    if (Object.keys(kept).length === 0) storage?.removeItem(KEY);
    else storage?.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage full or off: the edits last for this launch.
  }
};
