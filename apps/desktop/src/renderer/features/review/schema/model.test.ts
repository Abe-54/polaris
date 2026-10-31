import { describe, expect, test } from "bun:test";
import { type SchemaSourceDiff, type SchemaTableDiff, SessionId } from "@polaris/protocol";
import { type FileListRow, fileListRows } from "../model/fileList.ts";
import type { ReviewFile } from "../model/layout.ts";
import {
  type DataListRow,
  dataListRows,
  isDataRow,
  isMigrationPath,
  placeData,
  shownSources,
} from "./model.ts";

const table = (
  name: string,
  kind: SchemaTableDiff["kind"],
  rows: SchemaTableDiff["rows"]
): SchemaTableDiff => ({
  kind,
  before: kind === "added" ? null : { schema: "public", name },
  after: kind === "removed" ? null : { schema: "public", name },
  columns: [],
  indexes: [],
  constraints: [],
  rows,
});

const source = (
  name: string,
  tables: ReadonlyArray<SchemaTableDiff>,
  status: SchemaSourceDiff["status"] = "complete"
): SchemaSourceDiff => ({
  source: { id: `src-${name}`, name },
  status,
  baseline: "turn-start",
  beforeAt: "2026-10-30T12:00:00.000Z",
  afterAt: "2026-10-30T12:01:00.000Z",
  truncated: false,
  tables,
});

describe("the files list's Data section", () => {
  test("shows sources with changed tables or no comparison yet, and hides the rest", () => {
    const shown = shownSources({
      sessionId: SessionId.make("s"),
      sources: [
        source("app", [table("invoices", "changed", { kind: "unknown", value: null })]),
        source("cache", []),
        source("analytics", [], "pending"),
        source("warehouse", [], "unavailable"),
      ],
    });

    expect(shown.map((s) => s.source.name)).toEqual(["app", "analytics", "warehouse"]);
    expect(shownSources(null)).toEqual([]);
  });

  test("counts tables by kind and lists rows changed per table, unknown counts left out", () => {
    const rows = dataListRows([
      source("app", [
        table("currencies", "added", { kind: "exact", value: 3 }),
        table("invoices", "changed", { kind: "estimate", value: 214 }),
        table("payments", "changed", { kind: "unknown", value: null }),
        table("audit", "changed", { kind: "exact", value: 0 }),
        table("legacy", "removed", { kind: "unknown", value: null }),
      ]),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["data-head", "data-schema", "data-rows", "data-rows"]);
    const schema = rows[1];

    expect(schema?.kind === "data-schema" ? schema.counts.map((c) => c.text) : null).toEqual([
      "+1",
      "~3",
      "−1",
    ]);
    expect(rows.flatMap((r) => (r.kind === "data-rows" ? [`${r.table} ${r.figure}`] : []))).toEqual(
      ["currencies 3 matched", "invoices 214 est."]
    );
  });

  test("a Schema diff row carries why it's unavailable and whether others' changes are in it", () => {
    const schemaRow = (s: SchemaSourceDiff) =>
      dataListRows([s]).find((r) => r.kind === "data-schema");

    expect(
      schemaRow(source("app", [table("t", "added", { kind: "exact", value: 1 })]))
    ).toMatchObject({
      concurrent: false,
      reason: null,
    });
    expect(schemaRow({ ...source("app", []), concurrent: true })).toMatchObject({
      concurrent: true,
    });
    expect(
      schemaRow({
        ...source("warehouse", [], "unavailable"),
        afterAt: null,
        errorCode: "E-DATA-TIMEOUT",
      })
    ).toMatchObject({ reason: "Reading the schema timed out at the end of the turn" });
  });

  test("pruned history closes the section with its note, under a bare kicker when alone", () => {
    const note = {
      text: "Schema snapshot no longer kept for this turn",
      short: "Snapshot no longer kept",
    };

    expect(dataListRows([], note)).toEqual([
      { kind: "data-head", key: "data", name: null },
      { kind: "data-note", key: "data:pruned", ...note },
    ]);
    expect(dataListRows([source("app", [])], note).map((r) => r.kind)).toEqual([
      "data-head",
      "data-schema",
      "data-note",
    ]);
    expect(dataListRows([], null)).toEqual([]);
  });

  test("names five tables' rows, then how many more", () => {
    const tables = Array.from({ length: 8 }, (_, n) =>
      table(`t${n}`, "changed", { kind: "exact", value: n + 1 })
    );

    const rows = dataListRows([source("app", tables)]);

    expect(rows.filter((r) => r.kind === "data-rows")).toHaveLength(5);
    expect(rows.at(-1)).toMatchObject({ kind: "data-more", count: 3 });
  });
});

describe("migration paths", () => {
  test.each([
    "prisma/migrations/20261030_currencies/migration.sql",
    "drizzle/0003_currencies.sql",
    "db/migrate/20261030_add_currencies.rb",
    "migrations/0004.sql",
    "services/api/migrations/0004.sql",
    "supabase/migrations/20261030_currencies.sql",
  ])("%s is a migration", (path) => expect(isMigrationPath(path)).toBe(true));

  test.each(["src/migrations.ts", "db/migrate.ts", "docs/drizzle.md", "prisma/schema.prisma"])(
    "%s is not",
    (path) => expect(isMigrationPath(path)).toBe(false)
  );
});

const reviewFile = (path: string, index: number): ReviewFile => ({
  key: `t1:${path}`,
  index,
  section: "t1",
  // SAFETY: placement reads only the path; the rest of the patch file is unused here.
  file: { path } as ReviewFile["file"],
  fingerprint: path,
  generated: path.endsWith(".lock"),
  test: false,
});

describe("where the Data section sits", () => {
  const data = dataListRows([
    source("app", [table("currencies", "added", { kind: "exact", value: 3 })]),
  ]);

  type Row = FileListRow | DataListRow;

  const isMigration = (row: Row) => row.kind === "file" && isMigrationPath(row.file.file.path);

  const order = (rows: ReadonlyArray<Row>) =>
    rows.map((r) => {
      if (isDataRow(r)) return r.kind;

      return r.kind === "fold" ? `fold:${r.fold}` : r.file.file.path;
    });

  const rowsOf = (paths: ReadonlyArray<string>) =>
    fileListRows(paths.map(reviewFile), () => false, new Set());

  test("right after the last migration file", () => {
    const rows = placeData<Row>(
      rowsOf([
        "prisma/migrations/1_a/migration.sql",
        "prisma/migrations/2_b/migration.sql",
        "src/invoices.ts",
        "bun.lock",
      ]),
      data,
      isMigration,
      (r) => r.kind === "fold"
    );

    expect(order(rows)).toEqual([
      "prisma/migrations/1_a/migration.sql",
      "prisma/migrations/2_b/migration.sql",
      "data-head",
      "data-schema",
      "data-rows",
      "src/invoices.ts",
      "fold:generated",
    ]);
  });

  test("without a migration, after the files and before the folds", () => {
    const rows = placeData<Row>(
      rowsOf(["src/invoices.ts", "bun.lock"]),
      data,
      isMigration,
      (r) => r.kind === "fold"
    );

    expect(order(rows)).toEqual([
      "src/invoices.ts",
      "data-head",
      "data-schema",
      "data-rows",
      "fold:generated",
    ]);
  });
});
