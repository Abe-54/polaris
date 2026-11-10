import { describe, expect, test } from "bun:test";
import { applyHostItem, emptyHostFeed } from "../feed/fold.ts";
import {
  commandApproval,
  minutesAgo,
  NOW,
  question,
  session,
  snapshot,
  type SnapshotInput,
  summary,
} from "../fixtures.testing.ts";
import { heroKicker, nextUpIndex, nextUpMeta, pageHeights, pageIndex } from "./hero.ts";
import { buildHome, type HomeHost } from "./home.ts";

const hostWith = (sessions: NonNullable<SnapshotInput["sessions"]>): HomeHost => ({
  hostId: "h",
  name: "Mac Studio",
  connection: "connected",
  followed: {
    state: applyHostItem(emptyHostFeed, snapshot({ sessions })),
    seen: true,
    error: null,
  },
});

const spike = summary(session({ id: "spike", state: "needs-you" }), [
  commandApproval("spike", "r1", "cargo build", minutesAgo(42)),
]);

const form = summary(session({ id: "form", state: "needs-you" }), [
  question("form", "r2", "Monthly or annually?", ["Annual", "Monthly"]),
]);

const plan = summary(session({ id: "plan", state: "needs-you", updatedAt: minutesAgo(70) }));

const needing = (...sessions: ReadonlyArray<typeof spike>) =>
  buildHome([hostWith(sessions)], null).sections.needsYou;

describe("the pager's page", () => {
  // Oldest first: plan, spike, form.
  const rows = needing(spike, form, plan);
  const on = (index: number) => ({ key: rows[index]?.key ?? null, index });

  test("follows its row when an earlier one is answered", () => {
    expect(pageIndex(needing(spike, form), on(1))).toBe(0);
  });

  test("hands over to the next row when its own is answered", () => {
    expect(pageIndex(needing(form, plan), on(1))).toBe(1);
  });

  test("steps back when the last row is answered", () => {
    expect(pageIndex(needing(spike, plan), on(2))).toBe(1);
  });
});

describe("the pager's heights", () => {
  // Oldest first: plan, spike; form is never measured.
  const [planKey, spikeKey] = needing(spike, plan).map((row) => row.key);

  const measured = new Map([
    [planKey ?? "", 120],
    [spikeKey ?? "", 380],
  ]);

  test("wait until every page is measured", () => {
    expect(pageHeights(needing(spike, form, plan), measured)).toBeNull();
  });

  test("follow the rows' order, dropping an answered row's page", () => {
    expect(pageHeights(needing(spike, plan), measured)).toEqual([120, 380]);
    expect(pageHeights(needing(spike), measured)).toEqual([380]);
  });
});

test.each([
  [0, 2, "Needs you · 1 of 2"],
  [1, 3, "Needs you · 2 of 3"],
  [0, 1, "Needs you"],
])("page %p of %p reads %p", (index, count, kicker) => {
  expect(heroKicker(index, count)).toBe(kicker);
});

test.each([
  [0, 2, 1],
  [1, 2, 0],
  [0, 1, null],
])("on page %p of %p, next up opens page %p", (index, count, next) => {
  expect(nextUpIndex(index, count)).toBe(next);
});

test("next up says what the row waits on and since when", () => {
  const rows = needing(spike, form, plan);

  expect(rows.map((row) => nextUpMeta(row, NOW))).toEqual([
    "waiting · 1h",
    "command · 42m",
    "asks · now",
  ]);
});
