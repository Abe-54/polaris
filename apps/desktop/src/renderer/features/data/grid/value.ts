/**
 * How the grid shows a cell's `DataValue` (ENG-644): one clipped line in the grid, the whole value
 * in the inspector, CSV and ⌘L. `decodeRows` parses a result's rows where they arrive.
 */
import { DataValue, DataValueTags } from "@polaris/protocol";
import { Match, Predicate, Schema } from "effect";

type TaggedValue = typeof DataValueTags.Type;

export { DataValue, DataValueTags };

export type DataRow = ReadonlyArray<DataValue>;

/** Parses a result's rows at the boundary; None when any cell isn't a `DataValue`. */
export const decodeRows = Schema.decodeUnknownOption(Schema.Array(Schema.Array(DataValue)));

export type CellKind = "null" | "number" | "text" | "bool" | "json" | "bytes" | "time" | "cut";

export interface Cell {
  readonly kind: CellKind;
  /** The whole value as text; null for SQL NULL. */
  readonly raw: string | null;
  /** The database's size of a value cut short on the wire (`Truncated`). */
  readonly bytes?: number;
}

const NULL: Cell = { kind: "null", raw: null };

const tagged = (value: TaggedValue): Cell =>
  Match.valueTags(value, {
    Bytes: (v): Cell => ({ kind: "bytes", raw: v.preview ?? `${v.length} bytes` }),
    BigInt: (v): Cell => ({ kind: "number", raw: v.value }),
    Numeric: (v): Cell => ({ kind: "number", raw: v.value }),
    Json: (v): Cell => ({ kind: "json", raw: v.text }),
    Timestamp: (v): Cell => ({ kind: "time", raw: v.iso }),
    Truncated: (v): Cell => ({ kind: "cut", raw: v.preview, bytes: v.bytes }),
  });

export const cellOf = (value: DataValue | undefined): Cell => {
  if (value === null || value === undefined) return NULL;

  if (Predicate.isString(value)) return { kind: "text", raw: value };

  if (Predicate.isNumber(value)) return { kind: "number", raw: String(value) };

  if (Predicate.isBoolean(value)) return { kind: "bool", raw: String(value) };

  return tagged(value);
};

const one = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)));

/** "980 bytes", "1.0 MB"; "1,200 characters", "64K characters": what was counted, said. */
export const formatSize = (n: number, unit: "bytes" | "characters") => {
  if (unit === "characters")
    return n < 10_000
      ? `${n.toLocaleString("en-US")} characters`
      : n < 1_000_000
        ? `${one(n / 1000)}K characters`
        : `${one(n / 1_000_000)}M characters`;

  if (n < 1024) return `${n} bytes`;

  return n < 1024 * 1024 ? `${one(n / 1024)} KB` : `${one(n / 1024 / 1024)} MB`;
};

/** The most a grid cell draws; the inspector shows the rest. */
export const DISPLAY_CHARS = 200;

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** "48200" as "48 200" (a no-break space), left alone when it isn't a plain decimal. */
export const groupDigits = (raw: string): string => {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(raw);

  if (match === null) return raw;

  return `${match[1]}${(match[2] ?? "").replace(GROUP, " ")}${match[3] ?? ""}`;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bidi controls by name: drawn as marks, so one can't reorder what the cell shows. */
const BIDI = new Map([
  ["\u061C", "ALM"],
  ["\u200E", "LRM"],
  ["\u200F", "RLM"],
  ["\u202A", "LRE"],
  ["\u202B", "RLE"],
  ["\u202C", "PDF"],
  ["\u202D", "LRO"],
  ["\u202E", "RLO"],
  ["\u2066", "LRI"],
  ["\u2067", "RLI"],
  ["\u2068", "FSI"],
  ["\u2069", "PDI"],
]);

const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Bidi controls as `⟨RLO⟩`; the inspector shows line breaks and tabs as they are. */
export const showBidi = (text: string) =>
  text.replace(BIDI_CONTROL, (c) => `⟨${BIDI.get(c) ?? "?"}⟩`);

/** One line: each line break a ⏎ (a lone CR ␍), a tab ⇥, and bidi controls named. */
export const oneLine = (text: string) =>
  showBidi(
    text
      .replace(/\r\n|[\n\u0085\u2028\u2029]/g, "⏎")
      .replaceAll("\r", "␍")
      .replaceAll("\t", "⇥")
  );

/** "2026-08-02T09:30:00.000Z" as "2026-08-02 09:30:00Z": the T a space, whole-second millis gone. */
const formatTime = (iso: string) =>
  iso.replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ").replace(/\.000(?=Z|[+-]\d{2}(?::?\d{2})?$|$)/, "");

/** How a column reads its values: numbers grouped even when the driver sends them as strings. */
export interface DisplayHint {
  readonly numeric?: boolean;
}

/** The grid's words for values with no text of their own; italic, so they never read as text. */
export const PLACEHOLDERS = { null: "NULL", empty: "empty" } as const;

/** Whether the grid draws `cell` as a placeholder (NULL or the empty string), not its text. */
export const placeholderOf = (cell: Cell): keyof typeof PLACEHOLDERS | null => {
  if (cell.raw === null) return "null";

  return cell.raw === "" && cell.kind === "text" ? "empty" : null;
};

/** The start of the value, formatted for its kind: only ever the first DISPLAY_CHARS. */
const formatted = (cell: Cell, head: string, hint: DisplayHint) => {
  if (head.length < (cell.raw?.length ?? 0)) return head;

  if (cell.kind === "number" || (hint.numeric === true && cell.kind === "text"))
    return groupDigits(head);

  if (cell.kind === "time") return formatTime(head);

  return UUID.test(head) ? `${head.slice(0, 4)}…${head.slice(-3)}` : head;
};

/**
 * One line for the grid: clipped to DISPLAY_CHARS before anything else, then numbers grouped,
 * times spaced, uuids shortened, and line breaks, tabs and bidi controls drawn as marks.
 */
export const displayOf = (cell: Cell, hint: DisplayHint = {}): string => {
  const placeholder = placeholderOf(cell);

  if (placeholder !== null) return PLACEHOLDERS[placeholder];
  const raw = cell.raw ?? "";
  const line = oneLine(formatted(cell, raw.slice(0, DISPLAY_CHARS), hint));

  return raw.length > DISPLAY_CHARS || cell.kind === "cut" ? `${line}…` : line;
};

/** JetBrains Mono at 12px advances 7.2px a glyph. */
const GLYPH_PX = 7.2;

/**
 * `text` cut to what a cell `width` px wide (with `padding`) can show, ending in …: the grid
 * shapes a few dozen characters a cell, not 200. A wide glyph still clips with CSS ellipsis.
 */
export const fitWidth = (text: string, width: number, padding = 20) => {
  const room = Math.max(1, Math.floor((width - padding) / GLYPH_PX));

  if (text.length <= room) return text;
  const end = /[\uD800-\uDBFF]/.test(text[room - 2] ?? "") ? room - 2 : room - 1;

  return `${text.slice(0, end)}…`;
};

const LINE_BREAK = /[\r\n\u0085\u2028\u2029]/;

/**
 * Why a foreign key's value can't be followed to its row, or null when it can: the filter needs
 * the whole value, typed, on one line.
 */
export const unfollowable = (value: DataValue | undefined): string | null => {
  const cell = cellOf(value);

  if (cell.raw === null) return "NULL points at no row";

  if (cell.kind === "cut") return "The value was cut short on its way here, so it can't be matched";

  if (cell.kind === "bytes") return "A binary key can't be matched from its preview";

  return LINE_BREAK.test(cell.raw) ? "The value has a line break the filter can't hold" : null;
};
