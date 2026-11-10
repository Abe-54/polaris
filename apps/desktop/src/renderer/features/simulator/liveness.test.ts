import { describe, expect, test } from "bun:test";
import { barrierWatch, LIVENESS } from "./liveness.ts";

describe("barrierWatch", () => {
  test("an answered barrier is live, however long ago it went out", () => {
    const watch = barrierWatch();
    const id = watch.sent(0);

    watch.answered(id, true);
    expect(watch.stalled(60_000)).toBe(false);
  });

  test("a barrier unanswered past the limit is stalled, and not a moment before", () => {
    const watch = barrierWatch();

    watch.sent(1000);
    expect(watch.stalled(1000 + LIVENESS.answerWithinMs - 1)).toBe(false);
    expect(watch.stalled(1000 + LIVENESS.answerWithinMs)).toBe(true);
  });

  test("an answer with ok false is stalled at once, and a later ok answer clears it", () => {
    const watch = barrierWatch();

    watch.answered(watch.sent(0), false);
    expect(watch.stalled(1)).toBe(true);
    watch.answered(watch.sent(2), true);
    expect(watch.stalled(3)).toBe(false);
  });

  test("an answer settles the barriers sent before it", () => {
    const watch = barrierWatch();

    watch.sent(0);
    const second = watch.sent(10);

    watch.answered(second, true);
    expect(watch.stalled(10_000)).toBe(false);
  });

  test("an answer without an id settles the oldest", () => {
    const watch = barrierWatch();

    watch.sent(0);
    watch.sent(5000);
    watch.answered(null, true);
    expect(watch.stalled(5000 + LIVENESS.answerWithinMs - 1)).toBe(false);
    expect(watch.stalled(5000 + LIVENESS.answerWithinMs)).toBe(true);
  });

  test("an answer to an unknown id changes nothing", () => {
    const watch = barrierWatch();

    watch.sent(0);
    watch.answered(99, true);
    expect(watch.stalled(LIVENESS.answerWithinMs)).toBe(true);
  });

  test("a heartbeat is due only after the interval and only with nothing outstanding", () => {
    const watch = barrierWatch();

    expect(watch.due(0)).toBe(true);
    const id = watch.sent(0);

    expect(watch.due(LIVENESS.heartbeatMs)).toBe(false);
    watch.answered(id, true);
    expect(watch.due(LIVENESS.heartbeatMs - 1)).toBe(false);
    expect(watch.due(LIVENESS.heartbeatMs)).toBe(true);
  });
});
