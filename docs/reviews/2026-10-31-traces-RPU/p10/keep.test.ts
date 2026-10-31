/** P10 repro (ENG-657): Settings → Traces' Keep line against the Daemon's retention. FAILS on 99ca0343d. */
import { expect, test } from "bun:test";
import {
  DEFAULT_RETENTION,
  openTraceDatabase,
} from "../../../../apps/daemon/src/traces/database.ts";
import { pruneCheckout } from "../../../../apps/daemon/src/traces/retention.ts";
import { KEEP_LINE } from "../../../../apps/desktop/src/renderer/features/traces/settings/model.ts";

const DAY = 86400_000;

/** Whether one unpinned error Span `daysOld` days old survives the Daemon's default pruning. */
const errorSurvives = (daysOld: number): boolean => {
  const db = openTraceDatabase(":memory:");
  const now = Date.now();

  db.query("INSERT INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "c",
    "t1",
    "s1",
    null,
    "1",
    "2",
    "api",
    "error",
    now - daysOld * DAY,
    100,
    "{}"
  );
  pruneCheckout(db, "c", DEFAULT_RETENTION, now);
  const left = db.query("SELECT count(*) AS n FROM spans").get();

  db.close();

  return JSON.stringify(left) === JSON.stringify({ n: 1 });
};

test("finding P10-2: the Keep line's 'errors always' holds for an error older than the age limit", () => {
  expect(errorSurvives(1)).toBe(true);
  // Settings promises errors are kept always; the Daemon drops them past maxAgeMs (retention.ts).
  expect({ line: KEEP_LINE, kept: errorSurvives(8) }).toEqual({
    line: KEEP_LINE,
    kept: KEEP_LINE.includes("errors always"),
  });
});
