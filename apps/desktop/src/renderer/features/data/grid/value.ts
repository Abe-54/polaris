/**
 * How the grid shows a cell's `DataValue` (ENG-644): one clipped line in the grid, the whole value
 * in the inspector, CSV and ⌘L. `decodeRows` parses a result's rows where they arrive.
 */
import { Match, Predicate, Schema } from "effect";

/** CF's `DataValueTags` (protocol, ENG-644), until that lands; then import it from there. */
export const DataValueTags = Schema.TaggedUnion({
  Bytes: { length: Schema.Number, preview: Schema.optionalKey(Schema.String) },
  BigInt: { value: Schema.String },
  Numeric: { value: Schema.String },
  Json: { text: Schema.String },
  Timestamp: { iso: Schema.String },
  Truncated: { preview: Schema.String, bytes: Schema.Number },
});

type TaggedValue = typeof DataValueTags.Type;

export const DataValue = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.String,
  Schema.Number,
  DataValueTags,
]);

export type DataValue = typeof DataValue.Type;

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

/** One line for the grid: NULL spelled out, uuids shortened, numbers grouped, newlines shown. */
export const displayOf = (cell: Cell): string => {
  if (cell.raw === null) return "NULL";

  if (cell.kind === "number") return groupDigits(cell.raw);

  if (UUID.test(cell.raw)) return `${cell.raw.slice(0, 4)}…${cell.raw.slice(-3)}`;
  const line = cell.raw.slice(0, DISPLAY_CHARS).replace(/\r?\n/g, "⏎");

  return cell.raw.length > DISPLAY_CHARS || cell.kind === "cut" ? `${line}…` : line;
};
