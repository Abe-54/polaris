import { Schema } from "effect";
import { expect, test } from "bun:test";
import { TableDetail } from "@polaris/protocol";
import { compareCatalogs, type SnapshotTable, type CatalogSnapshot } from "./schemaCompare.ts";

const table = (name: string, change: Partial<ConstructorParameters<typeof TableDetail>[0]> = {}) =>
  new TableDetail({
    schema: "public",
    name,
    columns: [{ name: "id", type: "integer", nullable: false, default: null, pk: true, fk: null }],
    indexes: [],
    constraints: [],
    rowEstimate: 10,
    ...change,
  });

const snapshot = (...tables: SnapshotTable[]): CatalogSnapshot => ({
  at: "2026-10-30T00:00:00Z",
  tables,
  truncated: false,
});

test("migration rename plus added column/index retains column/default/nullability and constraint changes", () => {
  const before = table("invoices");

  const after = table("bills", {
    columns: [
      { ...before.columns[0]!, nullable: true, default: "7" },
      { name: "note", type: "text", nullable: true, default: null, pk: false, fk: null },
    ],
    indexes: [
      {
        name: "note_idx",
        columns: ["note"],
        unique: false,
        definition: "CREATE INDEX note_idx ON bills (note)",
      },
    ],
    constraints: [{ name: "positive", kind: "c", definition: "CHECK (id > 0)" }],
    rowEstimate: 13,
  });

  const diff = compareCatalogs(
    snapshot(Object.assign(before, { identity: "relation-1" })),
    snapshot(Object.assign(after, { identity: "relation-1" }))
  );

  expect(diff).toHaveLength(1);
  expect(diff[0]).toMatchObject({
    kind: "renamed",
    before: { name: "invoices" },
    after: { name: "bills" },
    rows: { kind: "estimate", value: 3 },
    columns: [
      {
        name: "id",
        before: { nullable: false, default: null },
        after: { nullable: true, default: "7" },
      },
      { name: "note", before: null, after: { type: "text" } },
    ],
    indexes: [{ name: "note_idx", before: null }],
    constraints: [{ name: "positive", before: null }],
  });
});

test("removed/retyped columns and deleted indexes/constraints expose both sides", () => {
  const before = table("orders", {
    columns: [
      ...table("orders").columns,
      { name: "old", type: "text", nullable: true, default: null, pk: false, fk: null },
    ],
    indexes: [{ name: "i", columns: ["old"], unique: false, definition: "BTREE" }],
    constraints: [{ name: "c", kind: "CHECK", definition: "old IS NOT NULL" }],
  });

  const after = table("orders", { columns: [{ ...before.columns[0]!, type: "bigint" }] });
  expect(compareCatalogs(snapshot(before), snapshot(after))[0]).toMatchObject({
    kind: "changed",
    columns: [
      { name: "id", before: { type: "integer" }, after: { type: "bigint" } },
      { name: "old", after: null },
    ],
    indexes: [{ name: "i", after: null }],
    constraints: [{ name: "c", after: null }],
  });
});

test("ambiguous matches are not reported as renames and truncated catalogs do not invent removals", () => {
  const diff = compareCatalogs(snapshot(table("old")), snapshot(table("new1"), table("new2")));
  expect(diff.map((x) => x.kind)).toEqual(["removed", "added", "added"]);
  expect(
    compareCatalogs(snapshot(table("old")), { ...snapshot(table("new1")), truncated: true })
  ).toEqual([]);
});

test("agent and user affected counts override estimates, zero exact counts remain exact", () => {
  const a = snapshot(table("orders"));
  const b = snapshot(table("orders", { rowEstimate: 99 }));
  expect(
    compareCatalogs(a, b, [
      { schema: "public", table: "orders", rows: 2, author: "agent" },
      { table: "orders", rows: 3, author: "user" },
    ])[0]?.rows
  ).toEqual({ kind: "exact", value: 5, agent: 2, user: 3 });
  expect(compareCatalogs(a, b, [{ table: "orders", rows: 0, author: "agent" }])[0]?.rows).toEqual({
    kind: "exact",
    value: 0,
    agent: 0,
    user: 0,
  });
});

test("unchanged catalogs produce no diff, unavailable row estimates stay unknown", () => {
  const a = snapshot(table("orders"));
  expect(compareCatalogs(a, a)).toEqual([]);
  expect(
    compareCatalogs(snapshot(), snapshot(table("orders", { rowEstimate: null })))[0]?.rows
  ).toEqual({ kind: "unknown", value: null });
});

test("stable identity distinguishes drop/create, even at the same name, from rename+alter", () => {
  const a = { ...Schema.encodeSync(TableDetail)(table("old")), identity: "1" };
  const b = { ...Schema.encodeSync(TableDetail)(table("new")), identity: "2" };
  expect(compareCatalogs(snapshot(a), snapshot(b)).map((x) => x.kind)).toEqual([
    "removed",
    "added",
  ]);
  expect(compareCatalogs(snapshot(a), snapshot({ ...b, name: "old" })).map((x) => x.kind)).toEqual([
    "removed",
    "added",
  ]);
  expect(
    compareCatalogs(snapshot(table("old")), snapshot(table("new"))).map((x) => x.kind)
  ).toEqual(["removed", "added"]);
  expect(
    compareCatalogs(snapshot(a), snapshot({ ...b, identity: "1", columns: [] }))[0]?.kind
  ).toBe("renamed");
});

test("one partial table never hides unrelated table additions and removals", () => {
  const wide = { ...Schema.encodeSync(TableDetail)(table("wide")), detailsTruncated: true };
  const diff = compareCatalogs(snapshot(wide, table("legacy")), snapshot(wide, table("payouts")));
  expect(diff.map((x) => [x.kind, x.before?.name ?? x.after?.name])).toEqual([
    ["removed", "legacy"],
    ["added", "payouts"],
  ]);
});

test("uncounted activity keeps stale zero estimates visible and counted author splits remain uncertain", () => {
  const a = snapshot(table("orders"));
  expect(compareCatalogs(a, a, [], true)[0]?.rows).toEqual({ kind: "estimate", value: 0 });
  expect(
    compareCatalogs(a, a, [{ table: "orders", rows: 5, author: "agent" }], true)[0]?.rows
  ).toEqual({ kind: "unknown", value: null, agent: 5, user: 0 });
});
