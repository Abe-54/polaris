import { describe, expect, test } from "bun:test";
import type { RiskFinding } from "@polaris/protocol";
import { session } from "../../home/fixtures.testing.ts";
import type { SessionRow } from "../../home/model/home.ts";
import { finding, summary } from "../review.testing.ts";
import {
  buildQueue,
  heroMeta,
  type QueueItem,
  queueAcceptState,
  queueItem,
  queueSummary,
  riskNote,
  type TurnRisk,
  wellMeta,
} from "./queue.ts";

const row = (id: string, since: number, host = "Mac Studio"): SessionRow => ({
  kind: "session",
  key: `${host}/${id}`,
  hostId: host,
  hostName: host,
  workspaceName: "polaris",
  session: session({ id, turnCount: 3, acceptedThroughIndex: 0 }),
  approval: null,
  replyPreview: null,
  since,
  stale: false,
});

const item = (id: string, since: number, risk: TurnRisk): QueueItem =>
  queueItem(row(id, since), {
    turnId: `${id}-t3`,
    number: 3,
    files: { count: 2, added: 10, removed: 4 },
    risk,
  });

const reviewed = (...findings: ReadonlyArray<RiskFinding>): TurnRisk => ({
  kind: "summary",
  summary: summary("completed", findings),
});

const keys = (items: ReadonlyArray<QueueItem>) => items.map((i): string => i.row.session.id);

describe("the review queue", () => {
  test("an open Critical leads, ahead of an older turn with more High findings and a newer one", () => {
    const queue = buildQueue([
      item(
        "highs",
        300,
        reviewed(finding("h1", "high"), finding("h2", "high"), finding("h3", "high"))
      ),
      item("critical", 100, reviewed(finding("c", "critical"), finding("l", "low"))),
      item("medium", 500, reviewed(finding("m", "medium"))),
    ]);

    expect(keys(queue.pages)).toEqual(["critical", "highs", "medium"]);
  });

  test("more open Criticals lead; a dismissed Critical is ranked by the tally, not as open", () => {
    const queue = buildQueue([
      item("dismissed", 900, reviewed(finding("d", "critical", { status: "dismissed" }))),
      item("one", 100, reviewed(finding("c1", "critical"))),
      item("two", 50, reviewed(finding("c2", "critical"), finding("c3", "critical"))),
    ]);

    expect(keys(queue.pages)).toEqual(["two", "one", "dismissed"]);
    expect(queue.critical).toBe(3);
  });

  test("a turn with only a dismissed Critical counts nothing and notes it was dismissed", () => {
    const only = item("d", 900, reviewed(finding("d", "critical", { status: "dismissed" })));

    const mixed = item(
      "m",
      900,
      reviewed(finding("d", "critical", { status: "dismissed" }), finding("h", "high"))
    );

    expect(only.tally.critical).toBe(0);
    expect(riskNote(only)).toBe("1 dismissed");
    expect(riskNote(mixed)).toBeNull();
    expect(mixed.findings.map((f) => f.identity)).toEqual(["h", "d"]);
  });

  test("equal tallies put the newest turn first, and unread turns follow every finding", () => {
    const queue = buildQueue([
      item("old", 100, reviewed(finding("a", "high"))),
      item("unreviewed", 900, { kind: "unreviewed" }),
      item("new", 200, reviewed(finding("b", "high"))),
    ]);

    expect(keys(queue.pages)).toEqual(["new", "old", "unreviewed"]);
  });

  test("only a finished review with nothing listed goes to the clean lane", () => {
    const queue = buildQueue([
      item("clean", 100, reviewed()),
      item("resolved", 200, reviewed(finding("r", "high", { status: "resolved" }))),
      item("reading", 300, { kind: "summary", summary: summary("running") }),
      item("failed", 400, { kind: "summary", summary: summary("failed") }),
      item("unreviewed", 500, { kind: "unreviewed" }),
      queueItem(row("loading", 600), null),
    ]);

    expect(keys(queue.clean)).toEqual(["resolved", "clean"]);
    expect(keys(queue.pages)).toEqual(["loading", "unreviewed", "failed", "reading"]);
  });

  test("the header counts open Criticals and every turn", () => {
    const queue = buildQueue([
      item("critical", 100, reviewed(finding("c", "critical"))),
      item("clean", 200, reviewed()),
    ]);

    expect(queueSummary(queue)).toEqual({ critical: "1 critical", rest: "2 turns to review" });
    expect(queueSummary(buildQueue([item("clean", 1, reviewed())]))).toEqual({
      critical: null,
      rest: "1 turn to review",
    });
  });
});

describe("a queued turn's lines", () => {
  const clean = item("clean", 1, reviewed());

  test("the hero names the host before the files; a well after, and a clean one says so", () => {
    expect(heroMeta(clean, true)).toBe("Turn 3 · Mac Studio · 2 files");
    expect(wellMeta(clean, true)).toBe("Turn 3 · 2 files · no findings · Mac Studio");
    expect(wellMeta(item("x", 1, { kind: "unreviewed" }), false)).toBe("Turn 3 · 2 files");
  });

  test("a big turn's file count keeps its thousands separator", () => {
    const big = queueItem(row("big", 1), {
      turnId: "big-t3",
      number: 3,
      files: { count: 1_284, added: 0, removed: 0 },
      risk: reviewed(),
    });

    expect(wellMeta(big, false)).toBe("Turn 3 · 1,284 files · no findings");
  });
});

describe("Accept from the queue", () => {
  test("a clean turn accepts at once; an open Critical pauses it for the confirmation", () => {
    expect(queueAcceptState(item("clean", 1, reviewed()), false).kind).toBe("ready");
    expect(queueAcceptState(item("c", 1, reviewed(finding("c", "critical"))), false)).toEqual({
      kind: "paused",
      critical: 1,
    });
  });

  test("an unread or still-reading turn can't be accepted from the queue", () => {
    expect(queueAcceptState(item("u", 1, { kind: "unreviewed" }), false).kind).toBe("unchecked");
    expect(queueAcceptState(queueItem(row("l", 1), null), false).kind).toBe("checking");
    const reading = item("r", 1, { kind: "summary", summary: summary("running") });

    expect(queueAcceptState(reading, false).kind).toBe("checking");
  });
});
