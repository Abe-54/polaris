import { expect, test } from "bun:test";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { spanStats, spanStatsPlan, type SpanStatsFilter } from "./stats.ts";

const filter: SpanStatsFilter = { sinceMs: 1_000, by: "both", sort: "count", limit: 20 };

const database = (ages: ReadonlyArray<number>) => {
  const db = openTraceDatabase(":memory:");

  const insert =
    db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration)
    VALUES ('checkout',?,?,NULL,?,?,'api','ok',?,100,'{}','data.query',1)`);

  for (const [index, age] of ages.entries()) {
    const start = sortableTime((BigInt(age) * 1_000_000n).toString());
    insert.run(`trace-${index}`, `span-${index}`, start, start, age);
  }

  return db;
};

test("the scan cap reads the newest spans and says which part of the window it covered", () => {
  const db = database([500, 2_000, 3_000, 4_000, 5_000]);

  expect(spanStats(db, "checkout", filter, 3)).toMatchObject({
    spans: 3,
    truncated: true,
    coveredSince: new Date(3_000).toISOString(),
    groups: [{ count: 3, latestStart: new Date(5_000).toISOString() }],
  });
  // The span before sinceMs is outside the window, so four fit under a cap of four.
  expect(spanStats(db, "checkout", filter, 4)).toMatchObject({
    spans: 4,
    truncated: false,
    coveredSince: null,
  });
});

test("every filter combination range-scans an index on checkout and age without a sort", () => {
  const db = database([]);

  for (const extra of [
    {},
    { name: "data" },
    { service: "api" },
    { status: "error" },
    { status: "ok", name: "x" },
  ] as const) {
    const plan = spanStatsPlan(db, "checkout", { ...filter, ...extra }).join("\n");

    expect(plan).toMatch(
      /^SEARCH spans USING INDEX spans_(retention|age) \(checkout=\? AND .*age>\?\)$/
    );
  }
});
