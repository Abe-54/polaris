import { describe, expect, test } from "bun:test";
import { TurnId, TurnItem } from "@polaris/protocol";
import { turnWith } from "../../../store/fixtures.testing.ts";
import type { TurnView } from "../../../store/sessionModel.ts";
import { conversationRows } from "./conversation.ts";
import {
  LONGEST,
  railLayout,
  railTurns,
  REST,
  tickLength,
  tickTurn,
  turnAt,
  turnsInView,
} from "./rail.ts";

const view = (index: number): TurnView => ({
  turn: turnWith({ id: TurnId.make(`t${index}`), index, prompt: `prompt ${index}` }),
  items: [TurnItem.cases.AssistantMessage.make({ id: `m${index}`, text: `reply ${index}` })],
  live: new Map(),
  subagents: [],
});

describe("turn rail", () => {
  test("ticks lengthen in an arc around the pointed one", () => {
    expect([0, 1, 2, 3, 4, 5].map((t) => tickLength(t, 3, false))).toEqual([
      13, 16, 19, 22, 19, 16,
    ]);
    expect(tickLength(9, 3, false)).toBe(REST);
    expect(tickLength(3, null, false)).toBe(REST);
  });

  test("Reduce Motion keeps only the pointed tick long", () => {
    expect([2, 3, 4].map((t) => tickLength(t, 3, true))).toEqual([REST, LONGEST, REST]);
  });

  test("ticks keep their pitch while they fit, and band Turns when they don't", () => {
    expect(railLayout(24, 600)).toEqual({ ticks: 24, pitch: 8, height: 192 });
    const crowded = railLayout(1000, 300);

    expect(crowded.ticks).toBe(100);
    expect(crowded.pitch).toBe(3);
    expect(tickTurn(50, crowded.ticks, 1000)).toBe(500);
  });

  test("a point down the rail names a Turn, clamped to the ends", () => {
    expect(turnAt(0, 192, 24)).toBe(0);
    expect(turnAt(140, 192, 24)).toBe(17);
    expect(turnAt(500, 192, 24)).toBe(23);
    expect(turnAt(-4, 192, 24)).toBe(0);
  });

  test("the Turns in view come from the rows on screen", () => {
    const turns = [view(0), view(1), view(2), view(3)];
    const rows = conversationRows({ turns, approvals: [] });
    const index = new Map<string, number>(turns.map((t, i) => [t.turn.id, i]));

    // Folded summaries for t0–t2, then t3's prompt and reply.
    expect(turnsInView(rows, 1, 3, index)).toEqual({ first: 1, last: 3 });
    expect(turnsInView(rows, 9, 12, index)).toBeNull();
  });

  test("a streaming frame redoes only the live Turn's tick (ENG-903)", () => {
    const done = [view(0), view(1), view(2)];
    const live = view(3);
    const before = railTurns([...done, live]);

    const edit = TurnItem.cases.FileChange.make({
      id: "f3",
      changes: [{ path: "src/a.ts", kind: "modify" }],
      status: "completed",
    });

    const frame = [...done, { ...live, items: [...live.items, edit] }];
    const after = railTurns(frame);

    expect(after.slice(0, 3).every((tick, n) => tick === before[n])).toBe(true);
    expect(after[3]).not.toBe(before[3]);
    expect(after[3]?.files).toBe(1);
    // Fresh views miss the cache: every tick computed again comes out the same.
    expect(after).toEqual(railTurns(frame.map((v) => ({ ...v }))));
  });
});
