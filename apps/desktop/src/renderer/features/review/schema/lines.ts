/**
 * A table's lines in the Schema Diff body (Paper D4): its columns, indexes and constraints,
 * each added, removed or changed with before → after. Pure, so tested.
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
  readonly what: "column" | "index" | "constraint";
  readonly name: string;
  readonly detail: string;
}

const columnFacts = (c: Column) =>
  [
    c.type,
    c.pk ? "primary key" : null,
    c.nullable ? "nullable" : "not null",
    c.default === null ? null : `default ${c.default}`,
    c.fk === null ? null : `→ ${c.fk.table}(${c.fk.column})`,
  ].filter((f) => f !== null);

const nullability = (c: Column) => (c.nullable ? "nullable" : "not null");

const fkText = (c: Column) =>
  c.fk === null ? "no foreign key" : `→ ${c.fk.table}(${c.fk.column})`;

/** What changed in a column, each as "before → after". */
const columnDelta = (before: Column, after: Column) =>
  [
    before.type === after.type ? null : `${before.type} → ${after.type}`,
    before.nullable === after.nullable ? null : `${nullability(before)} → ${nullability(after)}`,
    before.default === after.default
      ? null
      : `default ${before.default ?? "none"} → ${after.default ?? "none"}`,
    before.pk === after.pk ? null : after.pk ? "now primary key" : "no longer primary key",
    JSON.stringify(before.fk) === JSON.stringify(after.fk)
      ? null
      : `${fkText(before)} → ${fkText(after)}`,
  ].filter((f) => f !== null);

const indexText = (i: Index) => `(${i.columns.join(", ")})${i.unique ? " unique" : ""}`;

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

const definitionDelta = (b: { readonly definition: string }, a: { readonly definition: string }) =>
  `${b.definition} → ${a.definition}`;

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
        (b, a) => columnDelta(b, a).join(" · ")
      ),
    })),
    ...table.indexes.map((i): SchemaLine => ({
      key: `index:${i.name}`,
      change: changeOf(i.before, i.after, false),
      what: "index",
      name: i.name,
      detail: detailOf<Index>(i.before, i.after, indexText, (b, a) =>
        indexText(b) === indexText(a) ? definitionDelta(b, a) : `${indexText(b)} → ${indexText(a)}`
      ),
    })),
    ...table.constraints.map((c): SchemaLine => ({
      key: `constraint:${c.name}`,
      change: changeOf(c.before, c.after, false),
      what: "constraint",
      name: c.name,
      detail: detailOf<Constraint>(c.before, c.after, (k) => k.definition, definitionDelta),
    })),
  ];
};
