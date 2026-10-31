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
  /** A typed time must carry an offset (timestamptz), or must not (timestamp, DATETIME). */
  readonly zone?: "required" | "none";
  /** An integer column, or a numeric one's precision and scale: typed numbers must fit. */
  readonly digits?: Digits;
  /** The original text's line ending, kept when the user edits it. */
  readonly crlf?: boolean;
}

export type Digits =
  | { readonly integer: true; readonly unsigned: boolean }
  | { readonly integer: false; readonly precision: number; readonly scale: number };

export interface ColumnFacts {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly pk: boolean;
  /** MySQL's TIMESTAMP is absolute and its DATETIME local; Postgres spells both out. */
  readonly engine?: "postgres" | "mysql";
}

/** Why the whole table can't be edited, said once in the footer. */
export const NO_KEY = "This table has no primary key, so its rows can't be matched for an edit";

const BOOL = /^(?:bool|boolean|bit\(1\)|tinyint\(1\))$/i;

const JSON_TYPE = /^jsonb?$/i;

const TIME_TYPE = /^(?:timestamp|timestamptz|datetime)\b|^timestamp\b.*\bzone$/i;

const ZONED = /^timestamptz\b|with time zone/i;

const LOCAL = /without time zone|^datetime\b/i;

const INTEGER =
  /^(?:int|integer|smallint|bigint|mediumint|tinyint|int[248]|(?:small|big)?serial[248]?)\b(?:\(\d+\))?(\s+unsigned)?/i;

const DECIMAL = /^(?:numeric|decimal)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/i;

const zoneOf = (type: string, engine: ColumnFacts["engine"]): Editable["zone"] => {
  if (ZONED.test(type) || (engine === "mysql" && /^timestamp\b/i.test(type))) return "required";

  return LOCAL.test(type) || /^timestamp(?:\(\d+\))?$/i.test(type) ? "none" : undefined;
};

const digitsOf = (type: string): Digits | undefined => {
  const integer = INTEGER.exec(type.trim());

  if (integer !== null) return { integer: true, unsigned: integer[1] !== undefined };
  const decimal = DECIMAL.exec(type.trim());

  return decimal === null
    ? undefined
    : { integer: false, precision: Number(decimal[1]), scale: Number(decimal[2] ?? 0) };
};

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

  const zone = zoneOf(column.type.trim(), column.engine);
  const digits = kind === "number" ? digitsOf(column.type) : undefined;
  const crlf = kind === "text" && Predicate.isString(value) && value.includes("\r\n");

  return {
    kind,
    nullable: column.nullable,
    dateOnly: typed === "date",
    ...(zone === undefined ? undefined : { zone }),
    ...(digits === undefined ? undefined : { digits }),
    ...(crlf ? { crlf } : undefined),
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

/** A refused draft can carry the value it would take instead (a time without its offset). */
export type Parsed =
  | { readonly value: DataValue }
  | { readonly error: string; readonly suggestion?: string };

const WHOLE = "A whole number, like 42";

/** Why `t` doesn't fit the column's digits, or null when it does; never rounded to fit. */
const misfit = (t: string, digits: Digits | undefined): string | null => {
  if (digits === undefined) return null;

  if (digits.integer) {
    if (!/^[-+]?\d+$/.test(t)) return WHOLE;

    return digits.unsigned && /^-\d*[1-9]/.test(t) ? "This column takes no negative numbers" : null;
  }

  const parts = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(t);

  if (parts === null) return "Write the number without an exponent";
  const whole = (parts[1] ?? "").replace(/^0+/, "");
  const fraction = (parts[2] ?? "").replace(/0+$/, "");
  const { precision, scale } = digits;

  if (fraction.length > scale)
    return scale === 0
      ? WHOLE
      : `At most ${scale} ${scale === 1 ? "digit" : "digits"} after the point`;

  return whole.length > precision - scale
    ? `At most ${precision - scale} digits before the point`
    : null;
};

const parseNumber = (text: string, editable: Editable, before: DataValue): Parsed => {
  const t = text.trim();

  if (!NUMBER.test(t)) return { error: "Not a number" };
  const wrong = misfit(t, editable.digits);

  if (wrong !== null) return { error: wrong };
  const big = Predicate.isObject(before) && Predicate.isTagged(before, "BigInt");

  return { value: big ? Big.make({ value: t }) : Numeric.make({ value: t }) };
};

const parseTime = (text: string, editable: Editable): Parsed => {
  const t = text.trim();

  if (editable.dateOnly === true)
    return DATE.test(t) ? { value: t } : { error: "Write a date as 2026-08-02" };
  const match = TIME.exec(t);

  if (match === null || Number.isNaN(Date.parse(`${match[1]}T${match[2]}${match[3] ?? "Z"}`)))
    return { error: `Write a time as ${timeExample(editable)}` };

  if (editable.zone === "required" && match[3] === undefined)
    return { error: "Add an offset, like +00:00 or Z" };

  if (editable.zone === "none" && match[3] !== undefined)
    return {
      error: "This column has no time zone; write a local time",
      suggestion: `${match[1]} ${match[2]}`,
    };

  return { value: Timestamp.make({ iso: t }) };
};

/** The example a time editor shows: with an offset unless the column has no zone. */
export const timeExample = (editable: Editable) =>
  editable.zone === "none" ? "2026-08-02 09:30:00" : "2026-08-02 09:30:00+00:00";

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
      return parseNumber(text, editable, before);
    case "bool":
      return /^(?:true|false)$/.test(text)
        ? { value: text === "true" }
        : { error: "Choose true or false" };
    case "time":
      return parseTime(text, editable);
    case "json":
      return parseJson(text);
    default:
      // A field gives back LF; text that was CRLF keeps its line ending.
      return { value: editable.crlf === true ? text.replace(/\r?\n/g, "\r\n") : text };
  }
};

/** A decimal's value as sign, digits and exponent, so 42, "42.0" and "4.2e1" are one number. */
const decimalKey = (text: string) => {
  const parts = /^([-+]?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(text.trim());

  if (parts === null) return `text:${text}`;
  const fraction = parts[3] ?? "";
  let digits = `${parts[2] ?? ""}${fraction}`.replace(/^0+/, "");
  let exponent = Number(parts[4] ?? 0) - fraction.length;

  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    exponent += 1;
  }

  return digits === "" ? "0" : `${parts[1] === "-" ? "-" : ""}${digits}e${exponent}`;
};

/** A time as its instant when it has an offset, else its local text with zero fractions dropped. */
const timeKey = (text: string) => {
  const match = TIME.exec(text.trim());

  if (match === null) return `text:${text}`;
  const [, date, clock = "", offset] = match;
  const [whole = "00", fraction = ""] = (clock.slice(6) || "00").split(".");
  const hm = clock.slice(0, 5);
  const local = `${date}T${hm}:${whole}`;
  const micros = fraction.padEnd(6, "0");

  if (offset === undefined) return `local:${local}.${micros}`;

  const zone =
    offset.toUpperCase() === "Z" ? "+00:00" : offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");

  const instant = Date.parse(`${local}${zone.length === 3 ? `${zone}:00` : zone}`);

  return `instant:${instant}.${micros}`;
};

const truth = (value: DataValue) =>
  value === true || value === 1 || value === "1" || value === "true"
    ? "true"
    : value === false || value === 0 || value === "0" || value === "false"
      ? "false"
      : `other:${JSON.stringify(value)}`;

/** Two values the column stores alike: a typed no-op (CRLF, MySQL 0/1, a reformatted time). */
export const sameTyped = (editable: Editable, a: DataValue, b: DataValue): boolean => {
  if (a === null || b === null) return a === b;

  switch (editable.kind) {
    case "number":
      return decimalKey(draftOf(a)) === decimalKey(draftOf(b));
    case "bool":
      return truth(a) === truth(b);
    case "time":
      return editable.dateOnly === true
        ? draftOf(a) === draftOf(b)
        : timeKey(draftOf(a)) === timeKey(draftOf(b));
    case "text":
      return draftOf(a).replaceAll("\r\n", "\n") === draftOf(b).replaceAll("\r\n", "\n");
    default:
      return draftOf(a) === draftOf(b);
  }
};
