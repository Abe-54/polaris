import { describe, expect, test } from "bun:test";
import { type SchemaSourceDiff, type SchemaTableDiff, SessionId } from "@polaris/protocol";
import { type FileListRow, fileListRows } from "../model/fileList.ts";
import type { ReviewFile } from "../model/layout.ts";
import { tableLines } from "./lines.ts";
import {
  type DataListRow,
  dataListRows,
  isDataRow,
  isMigrationPath,
  placeData,
  rowsFigure,
  rowsWording,
  rowsSplit,
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

describe("rows wording", () => {
  test.each([
    [{ kind: "exact", value: 214 }, "214", "214 rows changed"],
    [{ kind: "exact", value: 1 }, "1", "1 row changed"],
    [{ kind: "exact", value: 0 }, "0", "0 rows changed"],
    [{ kind: "estimate", value: 1200 }, "~1,200", "~1,200 rows · estimate"],
    [{ kind: "estimate", value: -12 }, "~−12", "~−12 rows · estimate"],
    [{ kind: "unknown", value: null }, "unknown", "Rows changed: unknown"],
    // A Daemon that sent a value with "unknown" still never reads as a count.
    [{ kind: "unknown", value: 0 }, "unknown", "Rows changed: unknown"],
  ] as const)("%o reads %s / %s", (rows, figure, wording) => {
    expect(rowsFigure(rows)).toBe(figure);
    expect(rowsWording(rows)).toBe(wording);
  });

  test("splits agents' and the user's exact counts only when the Daemon did", () => {
    expect(rowsSplit({ kind: "exact", value: 214, agent: 200, user: 14 })).toBe(
      "200 by agents · 14 by you"
    );
    expect(rowsSplit({ kind: "exact", value: 3, agent: 3 })).toBe("3 by agents");
    expect(rowsSplit({ kind: "exact", value: 3 })).toBeNull();
  });
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
      ["currencies 3", "invoices ~214"]
    );
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

describe("a table's lines", () => {
  test("a changed column says what changed, before → after", () => {
    const column = (type: string, nullable: boolean) => ({
      name: "total_cents",
      type,
      nullable,
      default: null,
      pk: false,
      fk: null,
    });

    const lines = tableLines({
      ...table("invoices", "changed", { kind: "unknown", value: null }),
      columns: [
        { name: "total_cents", before: column("integer", true), after: column("bigint", false) },
        { name: "currency", before: null, after: column("char(3)", true) },
      ],
      indexes: [
        {
          name: "invoices_old_idx",
          before: { name: "invoices_old_idx", columns: ["id"], unique: true, definition: "" },
          after: null,
        },
      ],
    });

    expect(lines.map((l) => [l.change, l.what, l.name, l.detail])).toEqual([
      ["changed", "column", "total_cents", "integer → bigint · nullable → not null"],
      ["added", "column", "currency", "char(3)  nullable"],
      ["removed", "index", "invoices_old_idx", "(id) unique"],
    ]);
  });
});
