/**
 * A cell's editor by its value and column type: text, numeric (kept as text so no digit is
 * rounded), bool, timestamp with its offset, and JSON checked before it stages. NULL is a choice
 * of its own. Binary and cut-short values can't be edited; the reason says why.
 */
import { Match, Predicate } from "effect";
import { isNumericType } from "./columns.ts";
import { type DataValue, DataValueTags } from "./value.ts";

const { BigInt: Big, Json, Numeric, Timestamp } = DataValueTags.cases;

export type EditorKind = "text" | "number" | "bool" | "time" | "json";

export interface Editable {
  readonly kind: EditorKind;
  /** The column takes NULL, so the editor offers it. */
  readonly nullable: boolean;
  /** A `date` column: no time or offset. */
  readonly dateOnly?: boolean;
  /** The column stores an offset (timestamptz), so a typed time must carry one. */
  readonly zoned?: boolean;
}

export interface ColumnFacts {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly pk: boolean;
}

/** Why the whole table can't be edited, said once in the footer. */
export const NO_KEY = "This table has no primary key, so its rows can't be matched for an edit";

const BOOL = /^(?:bool|boolean|bit\(1\)|tinyint\(1\))$/i;

const JSON_TYPE = /^jsonb?$/i;

const TIME_TYPE = /^(?:timestamp|timestamptz|datetime)\b|^timestamp\b.*\bzone$/i;

const ZONED = /^timestamptz\b|with time zone/i;

const typeKind = (type: string): EditorKind | "date" => {
  const t = type.trim();

  if (BOOL.test(t)) return "bool";

  if (JSON_TYPE.test(t)) return "json";

  if (/^date$/i.test(t)) return "date";

  if (TIME_TYPE.test(t)) return "time";

  return isNumericType(t) ? "number" : "text";
};

type Tagged = typeof DataValueTags.Type;

/** What a tagged value edits as, or why it can't be written back whole. */
const taggedKind = (value: Tagged): EditorKind | { readonly reason: string } | null =>
  Match.valueTags(value, {
    Bytes: () => ({ reason: "Binary values can't be edited here" }),
    Truncated: () => ({ reason: "The value was cut short on its way here, so it can't be edited" }),
    BigInt: (): EditorKind => "number",
    Numeric: (): EditorKind => "number",
    Json: (): EditorKind => "json",
    Timestamp: (): EditorKind => "time",
  });

const valueKind = (value: DataValue): EditorKind | { readonly reason: string } | null => {
  if (value === null || Predicate.isString(value)) return null;

  if (Predicate.isBoolean(value)) return "bool";

  return Predicate.isNumber(value) ? "number" : taggedKind(value);
};

/**
 * How a cell edits, or why it can't: a key column is the row's identity, and binary or
 * cut-short values can't be written back whole.
 */
export const editorFor = (column: ColumnFacts, value: DataValue): Editable | string => {
  if (column.pk) return "Key columns can't be changed here; use a migration or the app's own code";

  const own = valueKind(value);

  if (Predicate.isObject(own)) return own.reason;
  const typed = typeKind(column.type);
  const byType = typed === "date" ? "time" : typed;
  // A MySQL boolean arrives as 0 or 1 and its JSON as text: the column type decides those.
  const kind = typed === "bool" || typed === "json" ? typed : (own ?? byType);

  return {
    kind,
    nullable: column.nullable,
    dateOnly: typed === "date",
    zoned: ZONED.test(column.type),
  };
};

/** "2026-08-02T09:30:00.000Z" as "2026-08-02 09:30:00Z", the way the grid shows it. */
const timeDraft = (iso: string) =>
  iso.replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ").replace(/\.000(?=Z|[+-]\d{2}(?::?\d{2})?$|$)/, "");

/** The editor's starting text. */
export const draftOf = (value: DataValue): string => {
  if (value === null) return "";

  if (Predicate.isString(value)) return value;

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);

  return Match.valueTags(value, {
    BigInt: (v) => v.value,
    Numeric: (v) => v.value,
    Json: (v) => v.text,
    Timestamp: (v) => timeDraft(v.iso),
    Bytes: (v) => v.preview ?? "",
    Truncated: (v) => v.preview,
  });
};

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const TIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

export type Parsed = { readonly value: DataValue } | { readonly error: string };

const parseNumber = (text: string, before: DataValue): Parsed => {
  const t = text.trim();

  if (!NUMBER.test(t)) return { error: "Not a number" };
  const big = Predicate.isObject(before) && Predicate.isTagged(before, "BigInt");

  return { value: big ? Big.make({ value: t }) : Numeric.make({ value: t }) };
};

const parseTime = (text: string, editable: Editable): Parsed => {
  const t = text.trim();

  if (editable.dateOnly === true)
    return DATE.test(t) ? { value: t } : { error: "Write a date as 2026-08-02" };
  const match = TIME.exec(t);

  if (match === null || Number.isNaN(Date.parse(`${match[1]}T${match[2]}${match[3] ?? "Z"}`)))
    return { error: "Write a time as 2026-08-02 09:30:00+00:00" };

  if (editable.zoned === true && match[3] === undefined)
    return { error: "Add an offset, like +00:00 or Z" };

  return { value: Timestamp.make({ iso: t }) };
};

const parseJson = (text: string): Parsed => {
  try {
    JSON.parse(text);

    return { value: Json.make({ text }) };
  } catch (error) {
    return {
      error: error instanceof Error ? `Not valid JSON · ${error.message}` : "Not valid JSON",
    };
  }
};

/** The editor's text as the value to stage, or what's wrong with it. */
export const parseDraft = (editable: Editable, text: string, before: DataValue): Parsed => {
  switch (editable.kind) {
    case "number":
      return parseNumber(text, before);
    case "bool":
      return /^(?:true|false)$/.test(text)
        ? { value: text === "true" }
        : { error: "Choose true or false" };
    case "time":
      return parseTime(text, editable);
    case "json":
      return parseJson(text);
    default:
      return { value: text };
  }
};
