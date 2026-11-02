import { expect, test } from "bun:test";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { spanCompare, type SpanCompareFilter } from "./spanCompare.ts";
import { spanStatsPlan } from "./stats.ts";

interface Row {
  readonly age: number;
  readonly name: string;
  readonly ms?: number;
  readonly error?: boolean;
  readonly version?: string;
}

const database = (rows: ReadonlyArray<Row>) => {
  const db = openTraceDatabase(":memory:");

  const insert =
    db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
    VALUES ('checkout',?,?,NULL,?,?,'api',?,?,100,?,?,?)`);

  for (const [index, row] of rows.entries()) {
    const start = sortableTime((BigInt(row.age) * 1_000_000n).toString());
    const resource = row.version === undefined ? {} : { "service.version": row.version };
    const value = JSON.stringify({ resource });
    const status = row.error === true ? "error" : "ok";
    insert.run(
      `t${index}`,
      `s${index}`,
      start,
      start,
      status,
      row.age,
      value,
      row.name,
      row.ms ?? 10
    );
  }

  return db;
};

const many = (count: number, row: Row) =>
  Array.from({ length: count }, (_, index) => ({ ...row, age: row.age + index }));

const windows = (extra: Partial<SpanCompareFilter> = {}): SpanCompareFilter => ({
  a: { sinceMs: 1_000, untilMs: 2_000 },
  b: { sinceMs: 2_000 },
  limit: 20,
  ...extra,
});

test("groups that appeared, disappeared and changed are listed largest change first; steady ones aren't", () => {
  const db = database([
    // Steady: the same share and timing on both sides, though B's window holds twice the spans.
    ...many(10, { age: 1_000, name: "steady" }),
    ...many(20, { age: 2_000, name: "steady" }),
    // Slower: p95 from 10 ms to 40 ms.
    ...many(10, { age: 1_100, name: "slower" }),
    ...many(20, { age: 2_100, name: "slower", ms: 40 }),
    // Failing: no errors in A, half in B.
    ...many(10, { age: 1_200, name: "failing" }),
    ...many(10, { age: 2_200, name: "failing" }),
    ...many(10, { age: 2_300, name: "failing", error: true }),
    ...many(3, { age: 1_300, name: "gone" }),
    ...many(5, { age: 2_400, name: "new" }),
  ]);

  const result = spanCompare(db, "checkout", windows());

  expect(result.changes.map((change) => [change.name, change.change])).toEqual([
    ["new", "appeared"],
    ["gone", "disappeared"],
    ["slower", "changed"],
    ["failing", "changed"],
  ]);
  expect(result).toMatchObject({ appeared: 1, disappeared: 1, changed: 2, unchanged: 1 });
  expect(result.changes[2]).toMatchObject({
    a: { count: 10, p95Ms: 10, errorRate: 0 },
    b: { count: 20, p95Ms: 40, errorRate: 0 },
    score: 0.75,
  });
  expect(result.changes[3]).toMatchObject({ b: { errors: 10, errorRate: 0.5 }, score: 0.5 });
  expect(result.changes[0]).toMatchObject({ a: null, b: { count: 5 }, example: { trace: "t97" } });
  expect(result.a).toMatchObject({ spans: 33, groups: 4, truncated: false });
});

test("a version side reads only spans whose resource names that build", () => {
  const db = database([
    ...many(4, { age: 1_000, name: "query", version: "0.8.3" }),
    ...many(4, { age: 1_100, name: "query", version: "0.8.4", ms: 100 }),
    ...many(2, { age: 1_200, name: "query" }),
  ]);

  const result = spanCompare(
    db,
    "checkout",
    windows({ a: { sinceMs: 0, version: "0.8.3" }, b: { sinceMs: 0, version: "0.8.4" } })
  );

  expect(result.a.spans).toBe(4);
  expect(result.b.spans).toBe(4);
  expect(result.changes).toMatchObject([
    { name: "query", change: "changed", a: { p95Ms: 10 }, b: { p95Ms: 100 } },
  ]);
});

test("each side's scan is capped on its own and says so", () => {
  const db = database([
    ...many(5, { age: 1_000, name: "x" }),
    ...many(5, { age: 2_000, name: "x" }),
  ]);

  expect(spanCompare(db, "checkout", windows(), 3)).toMatchObject({
    a: { spans: 3, truncated: true, coveredSince: new Date(1_002).toISOString() },
    b: { spans: 3, truncated: true, coveredSince: new Date(2_002).toISOString() },
  });
});

test("an until bound and a version filter keep the index range scan", () => {
  const db = database([]);

  const plan = spanStatsPlan(db, "checkout", {
    sinceMs: 1_000,
    untilMs: 2_000,
    version: "0.8.4",
    by: "both",
    sort: "count",
    limit: 20,
  }).join("\n");

  expect(plan).toMatch(
    /^SEARCH spans USING INDEX spans_retention \(checkout=\? AND age>\? AND age<\?\)$/
  );
});
