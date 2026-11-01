import { describe, expect, test } from "bun:test";
import { type SchemaSourceDiff, SessionId, TurnId } from "@polaris/protocol";
import {
  caveats,
  listFigure,
  provenance,
  prunedNote,
  rowsFigure,
  rowsLine,
  rowsSplit,
  rowsWording,
  unavailableReason,
} from "./copy.ts";

const source = (more: Partial<SchemaSourceDiff> = {}): SchemaSourceDiff => ({
  source: { id: "src-app", name: "app" },
  status: "complete",
  baseline: "turn-start",
  beforeAt: "2026-10-30T12:00:00.000Z",
  afterAt: "2026-10-30T12:01:00.000Z",
  truncated: false,
  tables: [],
  ...more,
});

test.each([
  [{ kind: "exact", value: 9 }, "9 matched"],
  [{ kind: "estimate", value: -1 }, "−1 est."],
  [{ kind: "estimate", value: 1200 }, "1,200 est."],
  [{ kind: "unknown", value: null }, "unknown"],
] as const)("the files list reads %o as %s, never as the table's size (F14)", (rows, figure) => {
  expect(listFigure(rows)).toBe(figure);
});

describe("rows wording", () => {
  test.each([
    [{ kind: "exact", value: 214 }, "214", "214 rows matched by writes through Polaris"],
    [{ kind: "exact", value: 1 }, "1", "1 row matched by writes through Polaris"],
    [{ kind: "exact", value: 0 }, "0", "0 rows matched by writes through Polaris"],
    [{ kind: "estimate", value: 1200 }, "~1,200", "~1,200 rows · estimate"],
    [{ kind: "estimate", value: -12 }, "~−12", "~−12 rows · estimate"],
    [{ kind: "unknown", value: null }, "unknown", "Rows: unknown"],
    // A Daemon that sent a value with "unknown" still never reads as a count.
    [{ kind: "unknown", value: 0 }, "unknown", "Rows: unknown"],
  ] as const)("%o reads %s / %s", (rows, figure, wording) => {
    expect(rowsFigure(rows)).toBe(figure);
    expect(rowsWording(rows)).toBe(wording);
  });

  test.each([
    [{ kind: "exact", value: 214, agent: 200, user: 14 }, "200 by agents · 14 by you"],
    [{ kind: "exact", value: 3, agent: 3, user: 0 }, "3 by agents"],
    [{ kind: "exact", value: 2, agent: 0, user: 2 }, "2 by you"],
    [{ kind: "exact", value: 0, agent: 0, user: 0 }, null],
    [{ kind: "exact", value: 3 }, null],
  ] as const)("%o splits as %p", (rows, split) => {
    expect(rowsSplit(rows)).toBe(split);
  });

  test("an unknown total keeps the counts Polaris did see, and still isn't 0", () => {
    expect(rowsLine({ kind: "unknown", value: null, agent: 5, user: 0 })).toBe(
      "Rows: unknown · 5 by agents"
    );
  });
});

describe("where the comparison starts", () => {
  const T4 = TurnId.make("t4");
  const T7 = TurnId.make("t7");
  const now = Date.parse("2026-10-30T14:00:00.000Z");
  const numbers = new Map([[T4, 4]]);

  const context = (turn?: string) => ({
    scope: "Start → end of turn 7",
    turn,
    turnNumber: (id: string) => numbers.get(TurnId.make(id)),
    now,
  });

  test("the end of the previous Turn says so, even when it carries a time", () => {
    const from = provenance(
      source({
        baseline: "previous-turn-end",
        baselineTurn: T4,
        baselineCapturedAt: "2026-10-30T12:00:00.000Z",
      }),
      context(T7)
    );

    expect(from).toEqual({ text: "Since the end of the previous turn", title: null });
  });

  test("a baseline carried from another Turn names it and when, absolute time on hover", () => {
    const from = provenance(
      source({
        baseline: "first-use",
        baselineTurn: T4,
        baselineCapturedAt: "2026-10-30T12:00:00.000Z",
      }),
      context(T7)
    );

    expect(from.text).toBe("Since turn 4 · 2 hours ago");
    expect(from.title).toContain("2026");
  });

  test("a carried baseline from a Turn the Review doesn't list still says when", () => {
    const from = provenance(
      source({
        baseline: "first-use",
        baselineTurn: TurnId.make("t-gone"),
        baselineCapturedAt: "2026-10-30T13:55:00.000Z",
      }),
      context(T7)
    );

    expect(from.text).toBe("Since 5 minutes ago");
  });

  test("the Turn's own baseline keeps the Turn's words", () => {
    const own = { baselineTurn: T7, baselineCapturedAt: "2026-10-30T12:00:00.000Z" };

    expect(provenance(source(own), context(T7)).text).toBe("Start → end of turn 7");
    expect(provenance(source({ ...own, baseline: "first-use" }), context(T7)).text).toBe(
      "Since this source was first used in the turn"
    );
  });
});

describe("caveats", () => {
  test("say other sessions' changes, a late baseline and a capped catalog, in that order", () => {
    expect(caveats(source({ concurrent: true, capturedLate: true, truncated: true }))).toEqual([
      "Includes changes from other sessions on this database, not only this turn’s",
      "Schema read after the turn started: changes made before then may be missing",
      "Large schema: additions and removals may be incomplete",
    ]);
    expect(caveats(source({ concurrent: false, capturedLate: false }))).toEqual([]);
  });
});

describe("why a diff is unavailable", () => {
  test.each([
    ["E-DATA-TIMEOUT", { afterAt: null }, "Reading the schema timed out at the end of the turn"],
    [
      "E-DATA-UNREACHABLE",
      { beforeAt: null },
      "Polaris couldn’t reach the database at the start of the turn",
    ],
    [
      "E-DATA-DENIED",
      {},
      "Polaris wasn’t allowed to read this schema. The data source isn’t approved, or it changed during the turn",
    ],
    [
      "E-DATA-UNKNOWN-SOURCE",
      { beforeAt: null, afterAt: null },
      "This data source is no longer set up at the start or end of the turn",
    ],
    [
      "E-DATA-SQL",
      { afterAt: null },
      "The database refused the schema read at the end of the turn",
    ],
    ["E-DATA-CANCELLED", {}, "Reading the schema was cancelled"],
  ])("%s reads in product words", (errorCode, more, reason) => {
    expect(unavailableReason(source({ status: "unavailable", errorCode, ...more }))).toBe(reason);
  });

  test("a code the Desktop App doesn't know falls back to which read failed, never the code", () => {
    const reason = unavailableReason(
      source({ status: "unavailable", errorCode: "E-DATA-NEW-THING", beforeAt: null })
    );

    expect(reason).toBe("Polaris couldn’t read this schema at the start of the turn");
  });
});

describe("pruned history", () => {
  const SESSION = SessionId.make("s");

  test("a pruned Turn and a pruned session say what's gone; nothing pruned says nothing", () => {
    expect(
      prunedNote({ sessionId: SESSION, turn: TurnId.make("t1"), pruned: true, sources: [] })
    ).toEqual({
      text: "Schema snapshot no longer kept for this turn",
      short: "Snapshot no longer kept",
    });
    expect(prunedNote({ sessionId: SESSION, pruned: true, sources: [] })).toEqual({
      text: "Schema snapshots of older turns are no longer kept",
      short: "Older snapshots not kept",
    });
    expect(prunedNote({ sessionId: SESSION, sources: [] })).toBeNull();
    expect(prunedNote(null)).toBeNull();
  });
});
