import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeLogRetention, pruneQueryLog } from "./logRetention.ts";

test("Host retention removes old entries across checkouts and bounds UTF-8 bytes", () => {
  const db = new Database(":memory:");

  try {
    db.exec("CREATE TABLE data_query_log (seq INTEGER PRIMARY KEY,checkout TEXT,value TEXT)");
    const put = db.query("INSERT INTO data_query_log VALUES (?,?,?)");
    const now = new Date("2026-10-30T12:00:00Z").getTime();
    put.run(0, "/old", JSON.stringify({ at: "2026-09-29T00:00:00Z", sql: "SELECT 1" }));

    for (let i = 1; i <= 40; i++)
      put.run(
        i,
        `/repo${i}`,
        JSON.stringify({ at: "2026-10-30T00:00:00Z", sql: "é".repeat(300000) })
      );
    initializeLogRetention(db);
    pruneQueryLog(db, now);
    expect(db.query("SELECT seq FROM data_query_log WHERE checkout='/old'").get()).toBeNull();

    const size = db
      .query<{ bytes: number; count: number }, []>(
        "SELECT sum(length(CAST(value AS BLOB))) AS bytes,count(*) AS count FROM data_query_log"
      )
      .get()!;

    expect(size.bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(size.count).toBeGreaterThan(20);
    expect(db.query("SELECT seq FROM data_query_log ORDER BY seq DESC LIMIT 1").get()).toEqual({
      seq: 40,
    });
  } finally {
    db.close();
  }
});

test("Host retention keeps the newest 10000 entries across all checkouts", () => {
  const db = new Database(":memory:");

  try {
    db.exec("CREATE TABLE data_query_log (seq INTEGER PRIMARY KEY,checkout TEXT,value TEXT)");
    const put = db.query("INSERT INTO data_query_log VALUES (?,?,?)");
    const value = JSON.stringify({ at: "2026-10-30T00:00:00Z", sql: "SELECT 1" });
    db.transaction(() => {
      for (let i = 0; i < 10003; i++) put.run(i, `/repo${i % 4}`, value);
    })();
    initializeLogRetention(db);
    pruneQueryLog(db, new Date("2026-10-30T12:00:00Z").getTime());
    expect(
      db
        .query("SELECT count(*) AS count,min(seq) AS first,max(seq) AS last FROM data_query_log")
        .get()
    ).toEqual({ count: 10000, first: 3, last: 10002 });
  } finally {
    db.close();
  }
});
