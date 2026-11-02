import { expect, test } from "bun:test";
import { Schema } from "effect";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { AttributeFilters, attributeCoverage, attributeTraces } from "./attributes.ts";
import { spanStats, spanStatsPlan, type SpanStatsFilter } from "./stats.ts";

const database = (
  spans: ReadonlyArray<{ age: number; attributes: Record<string, string | number | boolean> }>
) => {
  const db = openTraceDatabase(":memory:");

  const insert =
    db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
    VALUES ('checkout',?,?,NULL,?,?,'api','ok',?,100,?,'data.query',?)`);

  for (const [index, span] of spans.entries()) {
    const start = sortableTime((BigInt(span.age) * 1_000_000n).toString());
    const value = JSON.stringify({ attributes: span.attributes });
    insert.run(`trace-${index}`, `span-${index}`, start, start, span.age, value, index + 1);
  }

  return db;
};

const valid = Schema.is(AttributeFilters);

test("keys outside the OpenTelemetry charset, and more than five filters, are refused", () => {
  expect(valid([{ key: "db.system.name", value: "sqlite" }])).toBe(true);
  expect(valid([{ key: "http.response.status_code", value: 500 }])).toBe(true);

  for (const key of [`a"b`, "a\\b", "x') OR 1=1 --", "", "a b", "a".repeat(129)])
    expect(valid([{ key, value: "x" }])).toBe(false);

  expect(valid(Array.from({ length: 6 }, () => ({ key: "a", value: "x" })))).toBe(false);
});

const filter: SpanStatsFilter = { sinceMs: 1_000, by: "both", sort: "count", limit: 20 };

test("trace_stats filters on attribute equality, numbers matching int64 strings and booleans", () => {
  const db = database([
    { age: 2_000, attributes: { "db.system.name": "sqlite", rows: "12", cached: true } },
    { age: 3_000, attributes: { "db.system.name": "postgresql", rows: 12, cached: false } },
    { age: 4_000, attributes: { "db.system.name": "sqlite", rows: "7" } },
  ]);

  const spans = (attributes: AttributeFilters) =>
    spanStats(db, "checkout", { ...filter, attributes }).spans;

  expect(spans([{ key: "db.system.name", value: "sqlite" }])).toBe(2);
  expect(spans([{ key: "rows", value: 12 }])).toBe(2);
  expect(
    spans([
      { key: "rows", value: 12 },
      { key: "db.system.name", value: "sqlite" },
    ])
  ).toBe(1);
  expect(spans([{ key: "cached", value: true }])).toBe(1);
  expect(spans([{ key: "missing", value: "x" }])).toBe(0);
});

test("byAttribute groups by one attribute's value, with spans lacking it in a null group", () => {
  const db = database([
    { age: 2_000, attributes: { "db.system.name": "sqlite" } },
    { age: 3_000, attributes: { "db.system.name": "sqlite" } },
    { age: 4_000, attributes: { "db.system.name": "postgresql" } },
    { age: 5_000, attributes: {} },
  ]);

  const stats = spanStats(db, "checkout", { ...filter, by: "none", attribute: "db.system.name" });

  expect(stats.groups.map((group) => [group.attribute, group.count, group.name])).toEqual([
    ["sqlite", 2, undefined],
    [null, 1, undefined],
    ["postgresql", 1, undefined],
  ]);
  expect(
    spanStats(db, "checkout", { ...filter, by: "name", attribute: "db.system.name" }).groups[0]
  ).toMatchObject({ name: "data.query", attribute: "sqlite", count: 2 });
});

test("attribute filters and grouping keep the index range scan without a sort", () => {
  const db = database([]);

  const plan = spanStatsPlan(db, "checkout", {
    ...filter,
    attributes: [{ key: "db.system.name", value: "sqlite" }],
    attribute: "db.operation.name",
  }).join("\n");

  expect(plan).toMatch(/^SEARCH spans USING INDEX spans_retention \(checkout=\? AND age>\?\)$/);
});

test("traces' attribute filter reads only the newest spans, and says where it stopped", () => {
  const db = database([
    { age: 1_000, attributes: { tag: "x" } },
    { age: 2_000, attributes: { tag: "x" } },
    { age: 3_000, attributes: { tag: "y" } },
  ]);

  const matching = (scan: number) => {
    const query = attributeTraces("checkout", [{ key: "tag", value: "x" }], scan);

    return db
      .query(`SELECT trace_id FROM spans s WHERE ${query.sql} ORDER BY trace_id`)
      .values(...query.bindings)
      .flat();
  };

  const query = attributeTraces("checkout", [{ key: "tag", value: "x" }]);

  const plan = db
    .query(`EXPLAIN QUERY PLAN SELECT trace_id FROM summaries s WHERE ${query.sql}`)
    .values(...query.bindings)
    .map((row) => row.at(-1))
    .join("\n");

  // The newest Spans come off the retention index in order: no sort, no full scan.
  expect(plan).toContain("SEARCH spans USING INDEX spans_retention (checkout=?)");
  expect(plan).not.toContain("TEMP B-TREE");
  expect(matching(3)).toEqual(["trace-0", "trace-1"]);
  expect(matching(2)).toEqual(["trace-1"]);
  expect(attributeCoverage(db, "checkout", 2)).toBe(new Date(2_000).toISOString());
  expect(attributeCoverage(db, "checkout", 3)).toBeNull();
});
