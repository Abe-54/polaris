import { expect, test } from "bun:test";
import { daemon } from "../model/daemon.testing.ts";
import { KEEP_LINE } from "./model.ts";

const DAY = 86_400_000;

const { DEFAULT_RETENTION, openTraceDatabase, pruneCheckout } = daemon;

/** Whether one unpinned error Span `daysOld` days old survives the Daemon's default pruning. */
const errorSurvives = (daysOld: number): boolean => {
  const db = openTraceDatabase(":memory:");
  const now = Date.now();

  db.query(
    "INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).run("c", "t1", "s1", null, "1", "2", "api", "error", now - daysOld * DAY, 100, "{}");
  pruneCheckout(db, "c", DEFAULT_RETENTION, now);
  const left = db.query<{ n: number }, []>("SELECT count(*) AS n FROM spans").get();

  db.close();

  return left?.n === 1;
};

test("Settings → Traces' Keep line states the Daemon's default budget and age", () => {
  const mb = DEFAULT_RETENTION.maxBytes / (1024 * 1024);
  const days = DEFAULT_RETENTION.maxAgeMs / DAY;

  expect(KEEP_LINE).toBe(`${mb} MB · ${days} days`);
});

test("errors are pruned past the age limit too, so the Keep line can't promise them", () => {
  expect([errorSurvives(1), errorSurvives(8)]).toEqual([true, false]);
  expect(KEEP_LINE).not.toMatch(/error/);
});
