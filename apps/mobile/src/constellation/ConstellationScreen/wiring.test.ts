import { expect, test } from "bun:test";
import { reportedPrice } from "../stats/model.ts";
import { stats, usage } from "../stats/fixtures.testing.ts";
import {
  attempt,
  claim,
  galleryConstellation,
  NOW,
  projection,
  source,
  task,
} from "./fixtures.testing.ts";
import { starChartOf } from "./stars.ts";
import { turn } from "../../thread/daemon.testing.ts";
import { chipReading, claimNotice, reviewTurnOf } from "./wiring.ts";

test("the stats chip leads with the reported cost once every token is priced", () => {
  expect(chipReading("1h 12m", stats(), reportedPrice)).toBe("$4.82 · 1h 12m");
});

test.each([
  ["no stats yet", null],
  ["tokens the Harnesses didn't price", stats({ total: usage(2_400_000, 4.82, false) })],
  ["a zero cost", stats({ total: usage(0, 0) })],
])("the stats chip shows only the run time with %s", (_, read) => {
  expect(chipReading("1h 12m", read, reportedPrice)).toBe("1h 12m");
});

const lead = { sessionId: "lead", hostId: "mac" };

test("the claim notice opens the first claim handed to the user, by its chart label", () => {
  // MX-W: Screens' third task (B3) is the one claim in review, handed up.
  const header = galleryConstellation("header", lead, NOW);

  expect(claimNotice(header, starChartOf(header), NOW)).toEqual({
    taskId: "S3",
    text: "B3's claim is handed to you",
  });
});

test("the claim notice counts every claim handed up and opens the first", () => {
  // MX-X: Beta's two claims in review; every Alpha task before them is done.
  const compressed = galleryConstellation("compressed", lead, NOW);

  expect(claimNotice(compressed, starChartOf(compressed), NOW)).toEqual({
    taskId: "B5",
    text: "2 claims are handed to you",
  });
});

test("a claim in review the lead hasn't handed up raises no notice", () => {
  const reviewing = source(
    [task("A1")],
    [projection("A1", "review", "A1-a1")],
    [attempt("A1", 1, { state: "review", claim, claimedAt: "2026-10-27T11:50:00Z" })]
  );

  expect(claimNotice(reviewing, starChartOf(reviewing), NOW)).toBeNull();
});

test("ENG-575: the completion card reviews the lead's last turn by its user-turn number", () => {
  expect(reviewTurnOf(turn(40, { userTurnNumber: 31 }))).toEqual({
    label: "Review turn 31",
    turnId: "t-40",
  });
  // An older Host without user-turn numbers counts every Turn.
  expect(reviewTurnOf(turn(4))?.label).toBe("Review turn 5");
});

test("ENG-575: no Review button while the lead's last turn still works, or before any", () => {
  expect(reviewTurnOf(turn(3, { status: "working" }))).toBeNull();
  expect(reviewTurnOf(null)).toBeNull();
});
