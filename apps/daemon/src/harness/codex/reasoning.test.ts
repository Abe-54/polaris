import { describe, expect, test } from "bun:test";
import { TurnItem } from "@polaris/protocol";
import { ReasoningTimes } from "./reasoning.ts";

const reasoning = (id: string) =>
  TurnItem.cases.Reasoning.make({ id, text: "Thought.", startedAt: null, endedAt: null });

describe("ReasoningTimes", () => {
  test("uses Codex's own stamps: live from the start, timed at completion", () => {
    const times = new ReasoningTimes(() => 0);
    expect(times.start("r", Date.parse("2026-09-30T10:00:00Z"))).toMatchObject({
      text: "",
      startedAt: "2026-09-30T10:00:00.000Z",
      endedAt: null,
    });
    expect(times.finish(reasoning("r"), Date.parse("2026-09-30T10:00:12Z"))).toMatchObject({
      text: "Thought.",
      startedAt: "2026-09-30T10:00:00.000Z",
      endedAt: "2026-09-30T10:00:12.000Z",
    });
  });

  test("without stamps, the driver's clock; an item it never saw start stays untimed", () => {
    let now = Date.parse("2026-09-30T10:00:00Z");
    const times = new ReasoningTimes(() => now);
    times.start("r", undefined);
    now += 4000;
    expect(times.finish(reasoning("r"), 0)).toMatchObject({
      startedAt: "2026-09-30T10:00:00.000Z",
      endedAt: "2026-09-30T10:00:04.000Z",
    });
    expect(times.finish(reasoning("other"), 5)).toEqual(reasoning("other"));
  });
});
