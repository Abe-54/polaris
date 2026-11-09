import { describe, expect, test } from "bun:test";
import { ContextUsage, SessionId, Subagent, SubagentId, TurnId } from "@polaris/protocol";
import {
  contextRing,
  fitControlRow,
  litSegments,
  moonsOf,
  sendDisabled,
  sendPress,
  STOP_GRACE_MS,
} from "./controlRow.ts";

const helper = (id: string, status: Subagent["status"]) =>
  new Subagent({
    id: SubagentId.make(id),
    sessionId: SessionId.make("s-1"),
    turnId: TurnId.make("t-1"),
    parentItemId: null,
    title: id,
    agent: null,
    model: null,
    status,
    startedAt: "2026-10-29T12:00:00.000Z",
    endedAt: null,
  });

const usage = (usedTokens: number, windowTokens: number | null) =>
  new ContextUsage({ usedTokens, windowTokens });

describe("subagent moons", () => {
  test("only working Subagents count, at most three moons, each keeping its place", () => {
    const moons = moonsOf([
      helper("a", "completed"),
      helper("b", "working"),
      helper("c", "working"),
      helper("d", "failed"),
      helper("e", "working"),
      helper("f", "working"),
    ]);

    expect(moons.running).toBe(4);
    expect(moons.moons).toEqual([
      { id: "b", index: 1 },
      { id: "c", index: 2 },
      { id: "e", index: 4 },
    ]);
  });
});

describe("context ring", () => {
  test.each<[string, ContextUsage | null, { share: number; words: string; nearlyFull: boolean }]>([
    ["before any report: empty, never 0%", null, { share: 0, words: "—", nearlyFull: false }],
    [
      "window unknown: the tokens",
      usage(84_200, null),
      { share: 0, words: "84k", nearlyFull: false },
    ],
    [
      "window unknown, a shade under a million: 1M, never 1000k",
      usage(999_800, null),
      { share: 0, words: "1M", nearlyFull: false },
    ],
    [
      "a share of the window",
      usage(34_000, 200_000),
      { share: 0.17, words: "17%", nearlyFull: false },
    ],
    ["nearly full", usage(180_000, 200_000), { share: 0.9, words: "90%", nearlyFull: true }],
    [
      "past the window stays full",
      usage(250_000, 200_000),
      { share: 1, words: "100%", nearlyFull: true },
    ],
  ])("%s", (_, given, expected) => {
    expect(contextRing(given)).toEqual(expected);
  });

  test("any use lights a segment; none lights none", () => {
    expect([litSegments(0), litSegments(0.001), litSegments(0.17), litSegments(1)]).toEqual([
      0, 1, 3, 20,
    ]);
  });
});

describe("control row fit", () => {
  const crowded = { running: 20, attach: true, mic: true };

  test("a 402pt phone's row holds the demo's three moons, ring and words", () => {
    expect(fitControlRow(368, 1, { running: 3, attach: true, mic: true })).toEqual({
      moons: 3,
      ring: true,
      ringWords: true,
      mic: true,
    });
  });

  test("crowded, the ring's words and the extra moons give way before the ring and mic", () => {
    expect(fitControlRow(312, 1, crowded)).toEqual({
      moons: 1,
      ring: true,
      ringWords: false,
      mic: true,
    });
  });

  test("on a 320pt phone only the ring gives way: Queue lives in the Working strip, not here", () => {
    expect(fitControlRow(286, 1, crowded)).toEqual({
      moons: 1,
      ring: false,
      ringWords: false,
      mic: true,
    });
  });

  test("larger text needs more room for the same row", () => {
    const parts = { running: 3, attach: true, mic: true };

    expect(fitControlRow(368, 3, parts).ringWords).toBe(false);
  });

  test("before the row is measured, everything shows", () => {
    expect(fitControlRow(null, 1, crowded)).toEqual({
      moons: 3,
      ring: true,
      ringWords: true,
      mic: true,
    });
  });
});

describe("send and stop", () => {
  test("while the host is away Stop is off, and Send still takes a message to queue", () => {
    const away = { empty: false, blocked: false, away: true };

    expect([sendDisabled({ ...away, stop: true }), sendDisabled({ ...away, stop: false })]).toEqual(
      [true, false]
    );
  });

  test("a second tap just after Send doesn't stop the Turn it sent", () => {
    expect(sendPress({ stop: true, now: 1_000 + STOP_GRACE_MS - 1, sentAt: 1_000 })).toBe("ignore");
  });

  test("Stop stops once the moment has passed, or when nothing was sent from here", () => {
    expect([
      sendPress({ stop: true, now: 1_000 + STOP_GRACE_MS, sentAt: 1_000 }),
      sendPress({ stop: true, now: 1_000, sentAt: null }),
      sendPress({ stop: false, now: 1_000, sentAt: 999 }),
    ]).toEqual(["stop", "stop", "send"]);
  });
});
