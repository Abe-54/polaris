import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { decodeBatch } from "./decoder.ts";
import { openTraceDatabase, refreshSummary, writeBatch } from "./database.ts";
import { traceHistory } from "./queries.ts";
import { spanFixture, traceFixture, TEST_SESSION, TEST_WORKSPACE } from "./testing.ts";

const checkout = "/history-test";

const origin = BigInt(Date.now() - 300_000) * 1_000_000n;

const id = (n: number) => n.toString(16).padStart(32, "0");

const spanId = (n: number) => n.toString(16).padStart(16, "0");

const make = (trace: number, n: number, name: string, ms: number, at: number, parent?: number) => {
  const start = origin + BigInt(at) * 1_000_000n;

  return {
    ...spanFixture({
      traceId: id(trace),
      id: spanId(n),
      start: start.toString(),
      ...(parent === undefined ? undefined : { parentId: spanId(parent) }),
    }),
    name,
    endTimeUnixNano: (start + BigInt(ms) * 1_000_000n).toString(),
  };
};

const ingest = (db: Database, spans: ReturnType<typeof make>[], target = checkout) => {
  const batch = decodeBatch(
    new TextEncoder().encode(JSON.stringify(traceFixture(spans))),
    "traces",
    "application/json",
    {
      checkout: target,
      workspaceId: TEST_WORKSPACE,
      sessionId: TEST_SESSION,
      turns: [],
    }
  );

  db.transaction(() => {
    for (const [root, traces] of writeBatch(db, batch))
      for (const trace of traces) refreshSummary(db, root, trace);
  })();
};

test("history bounds each pair to recent samples and excludes future traces and other checkouts", () => {
  const db = openTraceDatabase(":memory:");

  try {
    for (let t = 1; t <= 110; t++)
      ingest(db, [
        make(t, 1, "R", t <= 60 ? 500 : 10, t * 1000),
        make(t, 2, "SQL", t <= 60 ? 400 : 2, t * 1000 + 1, 1),
      ]);
    ingest(db, [make(111, 1, "R", 200, 111_000), make(111, 2, "SQL", 90, 111_001, 1)]);

    for (let t = 112; t <= 120; t++) {
      ingest(db, [make(t, 1, "R", 900, t * 1000), make(t, 2, "SQL", 800, t * 1000 + 1, 1)]);
      ingest(db, [make(t, 1, "R", 900, 110_500), make(t, 2, "SQL", 800, 110_501, 1)], "/other");
    }

    const history = traceHistory(db, checkout, id(111));

    expect(history.root).toBe(10);
    expect(history.spans[spanId(2)]).toBe(2);
    expect(history.samples[spanId(2)]).toBe(50);
  } finally {
    db.close();
  }
});

test("history follows parents that arrive late, change name or are removed by retention", () => {
  const db = openTraceDatabase(":memory:");

  try {
    for (let t = 1; t <= 5; t++)
      ingest(db, [make(t, 1, "R", 10, t * 1000), make(t, 2, "SQL", 2, t * 1000 + 1, 1)]);
    ingest(db, [make(6, 2, "SQL", 80, 6001, 1)]);
    expect(traceHistory(db, checkout, id(6)).spans[spanId(2)]).toBeUndefined();
    ingest(db, [make(6, 1, "R", 100, 6000)]);
    expect(traceHistory(db, checkout, id(6)).spans[spanId(2)]).toBe(2);
    ingest(db, [make(6, 1, "different parent", 100, 6000)]);
    expect(traceHistory(db, checkout, id(6)).spans[spanId(2)]).toBeUndefined();
    ingest(db, [make(6, 1, "R", 100, 6000)]);
    db.query("DELETE FROM spans WHERE checkout=? AND trace_id=? AND id=?").run(
      checkout,
      id(6),
      spanId(1)
    );
    refreshSummary(db, checkout, id(6), true);
    expect(traceHistory(db, checkout, id(6)).spans[spanId(2)]).toBeUndefined();
  } finally {
    db.close();
  }
});

test("opening the previous trace database backfills indexed history without losing retained data", async () => {
  const dir = newTempDir("tf2-migration-", { short: true });
  const path = join(dir, "traces.sqlite");
  let db = openTraceDatabase(path);

  try {
    for (let t = 1; t <= 6; t++)
      ingest(db, [make(t, 1, "R", 10, t * 1000), make(t, 2, "SQL", 2, t * 1000 + 1, 1)]);
    db.exec(`DROP INDEX spans_history_covering;
      ALTER TABLE spans DROP COLUMN name;
      ALTER TABLE spans DROP COLUMN parent_name;
      ALTER TABLE spans DROP COLUMN trace_start;
      ALTER TABLE spans DROP COLUMN duration;`);
    db.close();
    db = openTraceDatabase(path);
    expect(traceHistory(db, checkout, id(6)).spans[spanId(2)]).toBe(2);
    expect(traceHistory(db, checkout, id(6)).samples[spanId(2)]).toBe(5);
    db.close();
    db = openTraceDatabase(path);
    expect(traceHistory(db, checkout, id(6)).root).toBe(10);
  } finally {
    db.close();
    await removeTempDirSettled(dir);
  }
});

test("bounded history computes the median of odd and even sample counts", () => {
  const db = openTraceDatabase(":memory:");

  try {
    for (const [index, ms] of [1, 3, 9, 11, 20].entries())
      ingest(db, [
        make(index + 1, 1, "R", 100, (index + 1) * 1000),
        make(index + 1, 2, "SQL", ms, (index + 1) * 1000 + 1, 1),
      ]);
    ingest(db, [make(7, 1, "R", 100, 7000), make(7, 2, "SQL", 200, 7001, 1)]);
    expect(traceHistory(db, checkout, id(7)).spans[spanId(2)]).toBe(9);
    ingest(db, [make(6, 1, "R", 100, 6000), make(6, 2, "SQL", 99, 6001, 1)]);
    expect(traceHistory(db, checkout, id(7)).spans[spanId(2)]).toBe(10);
  } finally {
    db.close();
  }
});
