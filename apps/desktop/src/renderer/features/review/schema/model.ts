/**
 * Review's Data section (DESIGN.md, Data → In Review; ENG-645): which sources of a
 * `DataSchemaDiff` the files list shows, their table counts, and where the
 * section sits among the files (right after the migrations that caused it). Pure, so tested.
 */
import type { DataSchemaDiff, SchemaSourceDiff, SchemaTableDiff } from "@polaris/protocol";
import { type PrunedNote, rowsFigure, rowsLine, unavailableReason } from "./copy.ts";

export type TableKind = SchemaTableDiff["kind"];

export type TableCounts = Readonly<Record<TableKind, number>>;

/** A known migration directory, as the Daemon's discovery reads them (data/README.md). */
const MIGRATION = /(^|\/)(prisma\/migrations|drizzle|db\/migrate|migrations)\//;

export const isMigrationPath = (path: string) => MIGRATION.test(path);

/** A source the Review shows: still capturing, failed, or with a table that changed. */
export const shownSources = (diff: DataSchemaDiff | null): ReadonlyArray<SchemaSourceDiff> =>
  diff?.sources.filter((s) => s.status !== "complete" || s.tables.length > 0) ?? [];

export const tableCounts = (source: SchemaSourceDiff): TableCounts => {
  const counts = { added: 0, changed: 0, renamed: 0, removed: 0 };

  for (const table of source.tables) counts[table.kind] += 1;

  return counts;
};

const SIGNS: ReadonlyArray<readonly [TableKind, string]> = [
  ["added", "+"],
  ["changed", "~"],
  ["renamed", "→"],
  ["removed", "−"],
];

/** "+1 ~1": each kind with tables, in a fixed order, as the files list's Schema diff row. */
export const countParts = (counts: TableCounts) =>
  SIGNS.flatMap(([kind, sign]) =>
    counts[kind] > 0 ? [{ kind, text: `${sign}${counts[kind].toLocaleString("en-US")}` }] : []
  );

/** A table's name as the Review shows it: `schema.name` outside the default schemas. */
export const tableName = (identity: { readonly schema: string; readonly name: string }) =>
  identity.schema === "" || identity.schema === "public" || identity.schema === "main"
    ? identity.name
    : `${identity.schema}.${identity.name}`;

/** The table as it is now (its old name when removed). */
export const currentName = (table: SchemaTableDiff) => {
  const identity = table.after ?? table.before;

  return identity === null ? "" : tableName(identity);
};

/** Tables whose row count moved, for the files list; unknown counts stay in the body. */
export const changedRows = (source: SchemaSourceDiff): ReadonlyArray<SchemaTableDiff> =>
  source.tables.filter(
    (t) => t.rows.kind !== "unknown" && t.rows.value !== null && t.rows.value !== 0
  );

/** Tables the body shows before "Show N more tables". */
export const FOLD_AFTER = 30;

/**
 * Puts the Data rows right after the last row `isMigration` matches; with no migration
 * among the rows, before the first row `isFold` matches (the folds that end the list).
 */
export const placeData = <R>(
  rows: ReadonlyArray<R>,
  data: ReadonlyArray<R>,
  isMigration: (row: R) => boolean,
  isFold: (row: R) => boolean = () => false
): ReadonlyArray<R> => {
  if (data.length === 0) return rows;
  const last = rows.findLastIndex(isMigration);
  const fold = rows.findIndex(isFold);
  let at = rows.length;

  if (last >= 0) at = last + 1;
  else if (fold >= 0) at = fold;

  return [...rows.slice(0, at), ...data, ...rows.slice(at)];
};

/** A row of the files list's Data section. */
export type DataListRow =
  | { readonly kind: "data-head"; readonly key: string; readonly name: string | null }
  | {
      readonly kind: "data-note";
      readonly key: string;
      readonly text: string;
      readonly short: string;
    }
  | {
      readonly kind: "data-schema";
      readonly key: string;
      readonly sourceId: string;
      readonly status: SchemaSourceDiff["status"];
      /** Why it's unavailable, as the row's tooltip. */
      readonly reason: string | null;
      /** Another session changed the same database during the comparison. */
      readonly concurrent: boolean;
      readonly counts: ReadonlyArray<{ readonly kind: TableKind; readonly text: string }>;
    }
  | {
      readonly kind: "data-rows";
      readonly key: string;
      readonly sourceId: string;
      readonly table: string;
      readonly figure: string;
      /** The rows card's full line, as the tooltip. */
      readonly title: string;
    }
  | {
      readonly kind: "data-more";
      readonly key: string;
      readonly sourceId: string;
      readonly count: number;
    };

/** Tables with changed rows the files list names per source before "N more tables". */
export const LISTED_ROWS = 5;

/** The section's last row when retention dropped the history; a lone "Data" kicker heads it. */
const prunedRows = (pruned: PrunedNote | null, alone: boolean): ReadonlyArray<DataListRow> => {
  if (pruned === null) return [];
  const note = { kind: "data-note", key: "data:pruned", ...pruned } as const;

  return alone ? [{ kind: "data-head", key: "data", name: null }, note] : [note];
};

/** "Data · app", its Schema diff row, then rows changed per table; then the pruned note. */
export const dataListRows = (
  sources: ReadonlyArray<SchemaSourceDiff>,
  pruned: PrunedNote | null = null
): ReadonlyArray<DataListRow> => [
  ...sources.flatMap((source): ReadonlyArray<DataListRow> => {
    const id = source.source.id;
    const rows = changedRows(source);

    return [
      { kind: "data-head", key: `data:${id}`, name: source.source.name },
      {
        kind: "data-schema",
        key: `data:${id}:schema`,
        sourceId: id,
        status: source.status,
        reason: source.status === "unavailable" ? unavailableReason(source) : null,
        concurrent: source.concurrent === true,
        counts: countParts(tableCounts(source)),
      },
      ...rows.slice(0, LISTED_ROWS).map((table): DataListRow => ({
        kind: "data-rows",
        key: `data:${id}:rows:${currentName(table)}`,
        sourceId: id,
        table: currentName(table),
        figure: rowsFigure(table.rows),
        title: rowsLine(table.rows),
      })),
      ...(rows.length > LISTED_ROWS
        ? [
            {
              kind: "data-more",
              key: `data:${id}:more`,
              sourceId: id,
              count: rows.length - LISTED_ROWS,
            } as const,
          ]
        : []),
    ];
  }),
  ...prunedRows(pruned, sources.length === 0),
];

const DATA_KINDS: ReadonlySet<string> = new Set([
  "data-head",
  "data-note",
  "data-schema",
  "data-rows",
  "data-more",
]);

export const isDataRow = (row: { readonly kind: string }): row is DataListRow =>
  DATA_KINDS.has(row.kind);
