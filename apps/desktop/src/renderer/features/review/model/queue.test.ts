import { describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import type { PullListView, PullRowView } from "../../../../shared/github.ts";
import { queueGroups, READY_LIMIT, readySessions, type SessionInfo } from "./queue.ts";

const session = (n: number, patch: Partial<SessionInfo> = {}): SessionInfo => ({
  hostKey: "h",
  id: SessionId.make(`s${n}`),
  title: `Session ${n}`,
  harness: "claude",
  state: "idle",
  turnCount: 24,
  acceptedThroughIndex: 20,
  userTurns: null,
  updatedAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  workspaceName: "polaris",
  ...patch,
});

const row = (number: number): PullRowView => ({
  id: `PR_${number}`,
  number,
  title: `PR ${number}`,
  url: "",
  repo: "acme/widgets",
  isDraft: false,
  author: { login: "mchen", avatarUrl: "" },
  headRefName: "x",
  headRefOid: "h",
  baseRefName: "main",
  additions: 1,
  deletions: 0,
  updatedAt: "",
  reviewDecision: "review-required",
  viewerLatestReview: null,
  requestedReviewers: [],
  accountId: 1,
  workspaces: [],
});

describe("readySessions", () => {
  test("idle sessions with Turns not yet accepted, newest first, with their Turn range", () => {
    const ready = readySessions([
      session(1),
      session(2, { state: "working" }),
      session(3, { acceptedThroughIndex: 23 }),
      session(4, { acceptedThroughIndex: null, turnCount: 1, workspaceName: null }),
    ]);

    expect(ready.map((r) => [r.title, r.meta])).toEqual([
      ["Session 4", "Turn 1"],
      ["Session 1", "Turns 22–24 · polaris"],
    ]);
  });

  test("with the Daemon's user Turns, the range is the user's: both ends, or neither", () => {
    // 24 Daemon Turns are 9 user Turns; accepted through Daemon Turn 21, user Turn 6.
    const user = (acceptedThrough: number | null) => ({ current: 9, acceptedThrough });

    const ready = readySessions([
      session(1, { userTurns: user(6) }),
      // An older Daemon didn't name the accepted user Turn: the Daemon's Turns, not a mix.
      session(2, { userTurns: user(null) }),
      session(3, { acceptedThroughIndex: null, userTurns: user(null) }),
      // Accepted through the user's Turn with a continuation still unaccepted.
      session(4, { acceptedThroughIndex: 22, userTurns: user(9) }),
    ]);

    expect(ready.map((r) => [r.title, r.meta])).toEqual([
      ["Session 4", "Turn 9 · polaris"],
      ["Session 3", "Turns 1–9 · polaris"],
      ["Session 2", "Turns 22–24 · polaris"],
      ["Session 1", "Turns 7–9 · polaris"],
    ]);
  });

  test("a few at most", () => {
    expect(readySessions(Array.from({ length: 9 }, (_, i) => session(i)))).toHaveLength(
      READY_LIMIT
    );
  });
});

test("queueGroups keeps DESIGN.md's order and drops empty groups", () => {
  const list: PullListView = {
    requested: [row(88)],
    mine: [],
    other: [row(17)],
    repos: [],
    updatedAt: null,
    polling: "idle",
    throttledUntil: null,
    error: null,
    errorKind: null,
  };

  const groups = queueGroups(list, [session(1)]);

  expect(groups.map((g) => [g.id, g.rows.length, g.compact])).toEqual([
    ["requested", 1, false],
    ["sessions", 1, false],
    ["other", 1, true],
  ]);
  expect(groups[0]?.rows[0]).toMatchObject({
    meta: "#88 · widgets · mchen",
    pull: { pullId: "PR_88" },
  });
});
