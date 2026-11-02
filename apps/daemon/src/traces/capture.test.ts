import { expect, test } from "bun:test";
import { openTraceDatabase, sortableTime } from "./database.ts";
import { spanCapture, spanCapturePlan, type SpanCaptureFilter } from "./capture.ts";

const filter: SpanCaptureFilter = { sinceMs: 1_000, untilMs: 4_000, cap: 500 };

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

test("a capture reads only the window, oldest first, and keeps the oldest past the cap", () => {
  const db = database([500, 3_000, 1_000, 2_000, 4_000, 4_500]);

  expect(spanCapture(db, "checkout", filter).spans.map((s) => s.span)).toEqual([
    "span-2",
    "span-3",
    "span-1",
    "span-4",
  ]);
  expect(spanCapture(db, "checkout", { ...filter, cap: 2 })).toMatchObject({
    spans: [{ span: "span-2" }, { span: "span-3" }],
    truncated: true,
  });
  expect(spanCapture(db, "checkout", { ...filter, cap: 4 }).truncated).toBe(false);
});

test("a capture range-scans the checkout and age index without a sort, with or without a name", () => {
  const db = database([]);

  for (const extra of [{}, { name: "data" }]) {
    const plan = spanCapturePlan(db, "checkout", { ...filter, ...extra }).join("\n");

    expect(plan).toMatch(
      /^SEARCH spans USING INDEX spans_retention \(checkout=\? AND age>\? AND age<\?\)$/
    );
  }
});
