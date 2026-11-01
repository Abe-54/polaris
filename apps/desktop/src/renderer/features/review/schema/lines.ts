/**
 * A table's lines in the Schema Diff body (Paper D4): its columns, indexes, constraints,
 * triggers and views, each added, removed or changed with before → after. Pure, so tested.
 */
import type { SchemaTableDiff } from "@polaris/protocol";

type ColumnChange = SchemaTableDiff["columns"][number];

type Column = NonNullable<ColumnChange["after"]>;

type IndexChange = SchemaTableDiff["indexes"][number];

type Index = NonNullable<IndexChange["after"]>;

type ConstraintChange = SchemaTableDiff["constraints"][number];

type Constraint = NonNullable<ConstraintChange["after"]>;

/** Added, removed, changed, or listed as it is (an added or removed table's own columns). */
export type LineChange = "added" | "removed" | "changed" | "same";

export interface SchemaLine {
  readonly key: string;
  readonly change: LineChange;
  /** "column", "index", or a constraint's own kind word: "trigger", "view", "check"… */
  readonly what: string;
  readonly name: string;
  readonly detail: string;
  /** A long definition, before → after, the body folds until asked. */
  readonly definition?: { readonly before: string | null; readonly after: string | null };
}

/** Said when only a fingerprint moved: a change the visible fields don't explain. */
export const DEFINITION_CHANGED = "definition changed";

const generatedText = (c: Column) =>
  c.generated === undefined ? "not generated" : `generated as ${c.generated}`;

const columnFacts = (c: Column) =>
  [
    c.type,
    c.pk ? "primary key" : null,
    c.nullable ? "nullable" : "not null",
    c.default === null ? null : `default ${c.default}`,
    c.generated === undefined ? null : generatedText(c),
    c.collation === undefined ? null : `collate ${c.collation}`,
    c.extra === undefined || c.extra === "" ? null : c.extra,
    c.fk === null ? null : `→ ${c.fk.table}(${c.fk.column})`,
  ].filter((f) => f !== null);

const nullability = (c: Column) => (c.nullable ? "nullable" : "not null");

const fkText = (c: Column) =>
  c.fk === null ? "no foreign key" : `→ ${c.fk.table}(${c.fk.column})`;

const optional = (label: string, before: string | undefined, after: string | undefined) =>
  before === after ? null : `${label} ${before ?? "none"} → ${after ?? "none"}`;

/** What changed in a column, each as "before → after". */
const columnDelta = (before: Column, after: Column) =>
  [
    before.type === after.type ? null : `${before.type} → ${after.type}`,
    before.nullable === after.nullable ? null : `${nullability(before)} → ${nullability(after)}`,
    before.default === after.default
      ? null
      : `default ${before.default ?? "none"} → ${after.default ?? "none"}`,
    before.generated === after.generated
      ? null
      : `${generatedText(before)} → ${generatedText(after)}`,
    optional("collation", before.collation, after.collation),
    optional("extra", before.extra, after.extra),
    before.pk === after.pk ? null : after.pk ? "now primary key" : "no longer primary key",
    JSON.stringify(before.fk) === JSON.stringify(after.fk)
      ? null
      : `${fkText(before)} → ${fkText(after)}`,
  ].filter((f) => f !== null);

/** The visible delta, or "definition changed" when only the fingerprint tells them apart. */
const explained = (
  delta: ReadonlyArray<string>,
  before: { readonly fingerprint?: string },
  after: { readonly fingerprint?: string }
) =>
  delta.length === 0 && before.fingerprint !== after.fingerprint
    ? DEFINITION_CHANGED
    : delta.join(" · ");

const indexText = (i: Index) => `(${i.columns.join(", ")})${i.unique ? " unique" : ""}`;

const indexDelta = (b: Index, a: Index) => {
  if (indexText(b) !== indexText(a)) return `${indexText(b)} → ${indexText(a)}`;

  return explained(
    b.definition === a.definition ? [] : [`${b.definition} → ${a.definition}`],
    b,
    a
  );
};

/** Postgres `contype` letters and MySQL's CONSTRAINT_TYPE, as their own words. */
const KIND_WORDS = new Map([
  ["p", "primary key"],
  ["primary key", "primary key"],
  ["f", "foreign key"],
  ["foreign key", "foreign key"],
  ["u", "unique"],
  ["unique", "unique"],
  ["c", "check"],
  ["check", "check"],
  ["x", "exclusion"],
  ["t", "constraint trigger"],
  ["n", "not null"],
  ["trigger", "trigger"],
  ["view", "view"],
  ["security", "row security"],
]);

export const kindWord = (kind: string) => KIND_WORDS.get(kind.trim().toLowerCase()) ?? "constraint";

/** Postgres row security's "enabled:forced" flags, read out. */
const securityText = (definition: string) => {
  const [enabled, forced] = definition.split(":");

  return `${enabled === "true" ? "on" : "off"}${forced === "true" ? ", forced" : ""}`;
};

const definitionOf = (c: Constraint) =>
  kindWord(c.kind) === "row security" ? securityText(c.definition) : c.definition;

/** Past this, or over several lines, a definition folds behind "Show definition". */
export const LONG_DEFINITION = 80;

const isLong = (text: string | null) =>
  text !== null && (text.length > LONG_DEFINITION || text.includes("\n"));

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const changeOf = <A>(before: A | null, after: A | null, listed: boolean): LineChange => {
  if (listed) return "same";

  if (before === null) return "added";

  return after === null ? "removed" : "changed";
};

const detailOf = <A>(
  before: A | null,
  after: A | null,
  describe: (a: A) => string,
  delta: (b: A, a: A) => string
) => {
  if (before !== null && after !== null) return delta(before, after);
  const side = after ?? before;

  return side === null ? "" : describe(side);
};

const constraintLine = (c: ConstraintChange): SchemaLine => {
  const side = c.after ?? c.before;
  const before = c.before === null ? null : definitionOf(c.before);
  const after = c.after === null ? null : definitionOf(c.after);
  const long = isLong(before) || isLong(after);

  const line: SchemaLine = {
    key: `constraint:${c.name}`,
    change: changeOf(c.before, c.after, false),
    what: side === null ? "constraint" : kindWord(side.kind),
    name: c.name,
    detail: detailOf<Constraint>(
      c.before,
      c.after,
      (k) => oneLine(definitionOf(k)),
      (b, a) =>
        long && before !== after
          ? DEFINITION_CHANGED
          : explained(before === after ? [] : [`${before} → ${after}`], b, a)
    ),
  };

  return long ? { ...line, definition: { before, after } } : line;
};

export const tableLines = (table: SchemaTableDiff): ReadonlyArray<SchemaLine> => {
  // An added or removed table lists its columns as they are, without signs.
  const listed = table.kind === "added" || table.kind === "removed";

  return [
    ...table.columns.map((c): SchemaLine => ({
      key: `column:${c.name}`,
      change: changeOf(c.before, c.after, listed),
      what: "column",
      name: c.name,
      detail: detailOf<Column>(
        c.before,
        c.after,
        (col) => columnFacts(col).join("  "),
        (b, a) => explained(columnDelta(b, a), b, a)
      ),
    })),
    ...table.indexes.map((i): SchemaLine => ({
      key: `index:${i.name}`,
      change: changeOf(i.before, i.after, false),
      what: "index",
      name: i.name,
      detail: detailOf<Index>(i.before, i.after, indexText, indexDelta),
    })),
    ...table.constraints.map(constraintLine),
  ];
};
