import { describe, expect, test } from "bun:test";
import { DataSource, SchemaTree, TableSummary } from "@polaris/protocol";
import { Schema } from "effect";
import { FIXTURE_SCHEMA, FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { openSources, type TreeLoad, type TreeRow, treeRows } from "./tree.ts";

const fields = Schema.encodeSync(DataSource);

// SAFETY: the fixtures hold app, the ledger branch and analytics, in that order.
const [app, branch, analytics] = FIXTURE_SOURCES as [DataSource, DataSource, DataSource];

const ready = (value: SchemaTree): TreeLoad => ({ status: "ready", value });

/** Each row as one readable line: its kind and what it names. */
const lines = (rows: ReadonlyArray<TreeRow>) =>
  rows.map((row) => {
    switch (row.kind) {
      case "source":
        return `${row.open ? "▾" : "▸"} ${row.source.name}`;
      case "schema":
        return `  ${row.open ? "▾" : "▸"} ${row.name} ${row.count}`;
      case "table":
        return `    ${row.table}${row.change === null ? "" : ` ${row.change}`}`;
      case "functions":
        return `    ${row.open ? "▾" : "▸"} functions ${row.count}`;
      case "function":
        return `      ${row.name}`;
      default:
        return `  · ${row.text}`;
    }
  });

const input = (over: Partial<Parameters<typeof treeRows>[0]> = {}) => ({
  sources: FIXTURE_SOURCES,
  trees: new Map([["app", ready(FIXTURE_SCHEMA)]]),
  changes: [],
  toggled: new Map<string, boolean>(),
  ...over,
});

describe("the Sources tree", () => {
  test("opens the first browsable source; a locked remote says why, with nothing under it", () => {
    expect(
      lines(
        treeRows(
          input({
            changes: [{ source: "app", schema: "public", table: "currencies", change: "added" }],
          })
        )
      )
    ).toEqual([
      "▾ app",
      "  ▾ public 7",
      "    customers",
      "    invoices",
      "    invoice_items",
      "    payments",
      "    currencies added",
      "    users",
      "    _prisma_migrations",
      "    ▸ functions 3",
      "▸ ledger",
      "▸ analytics",
      "  · Agents can't reach it until you approve it.",
    ]);
  });

  test("a locked first source is skipped for the default; only open sources are read", () => {
    const sources = [analytics, branch, app];

    expect(openSources({ sources, changes: [], toggled: new Map() })).toEqual(["ledger"]);
    expect(lines(treeRows(input({ sources, trees: new Map() }))).slice(0, 4)).toEqual([
      "▸ analytics",
      "  · Agents can't reach it until you approve it.",
      "▾ ledger",
      "  · Reading schema…",
    ]);
  });

  test("toggles close a source and open the functions group", () => {
    const toggled = new Map([
      ["source\u0000app", false],
      ["source\u0000ledger", true],
      ["functions\u0000ledger\u0000public", true],
    ]);

    const rows = lines(
      treeRows(input({ toggled, trees: new Map([["ledger", ready(FIXTURE_SCHEMA)]]) }))
    );

    expect(rows.slice(0, 3)).toEqual(["▸ app", "▾ ledger", "  ▾ public 7"]);
    expect(rows.slice(-6)).toEqual([
      "    ▾ functions 3",
      "      overdue_total(uuid)",
      "      set_updated_at()",
      "      invoice_number()",
      "▸ analytics",
      "  · Agents can't reach it until you approve it.",
    ]);
  });

  test("an unreachable source and a failed schema read each say so", () => {
    const down = new DataSource({ ...fields(app), reachable: false, error: "connection refused" });

    const failed = lines(
      treeRows(input({ trees: new Map([["app", { status: "failed", message: "timeout" }]]) }))
    );

    expect(lines(treeRows(input({ sources: [down] })))).toEqual([
      "▸ app",
      "  · Can't reach localhost:5432 · connection refused",
    ]);
    expect(failed.slice(0, 2)).toEqual(["▾ app", "  · Couldn't read its schema · timeout"]);
  });

  test("past one schema, tables are schema-qualified for their tabs; truncation is counted", () => {
    const table = new TableSummary({ name: "events", rowEstimate: 10, columnCount: 2 });

    const tree = new SchemaTree({
      schemas: [
        { name: "public", tables: [table], views: [], functions: [] },
        { name: "audit", tables: [table], views: [], functions: [] },
      ],
      truncatedTables: 12,
    });

    expect(
      lines(treeRows(input({ sources: [app], trees: new Map([["app", ready(tree)]]) })))
    ).toEqual([
      "▾ app",
      "  ▾ public 1",
      "    public.events",
      "  ▾ audit 1",
      "    audit.events",
      "  · 12 more tables not shown",
    ]);
  });
});
