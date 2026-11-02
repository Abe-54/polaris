import { afterEach, describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Fiber, Logger } from "effect";
import { captureCheckpoint, checkpointRef } from "./Checkpoints.ts";
import { gitText } from "./git.ts";
import {
  type CheckpointRef,
  type CheckpointSession,
  DEFAULT_CHECKPOINT_POLICY,
  dropSessionCheckpoints,
  listCheckpointRefs,
  onSessionArchived,
  parseCheckpointRef,
  planCheckpointPrune,
  pruneCheckpoints,
  runCheckpointSweeper,
  sweepCheckpoints,
} from "./prune.ts";
import { commitAll, makeRepo, removeDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const repo = async () => {
  const root = await makeRepo();
  cleanup.push(root);

  return root;
};

const DAY = 24 * 60 * 60 * 1000;

const NOW = 1_800_000_000_000;

/** Refs for Turns t1..tn of `sessionId`, each with before and after, t1 oldest. */
const refsFor = (sessionId: string, turns: number): Array<CheckpointRef> =>
  Array.from({ length: turns }, (_, i) => i + 1).flatMap((n) =>
    (["before", "after"] as const).map((label) => ({
      ref: checkpointRef(sessionId, `t${n}`, label),
      sessionId,
      turnId: `t${n}`,
      label,
      commit: `c${n}${label}`,
      time: 1000 + n * 10 + (label === "after" ? 5 : 0),
    }))
  );

const archived = (sessionId: string, ageMs: number, extra: Partial<CheckpointSession> = {}) => ({
  sessionId,
  archivedAt: NOW - ageMs,
  ...extra,
});

describe("planCheckpointPrune", () => {
  test("parses refs, including session ids with slashes", () => {
    expect(parseCheckpointRef("refs/polaris/checkpoints/s1/t1/before")).toEqual({
      sessionId: "s1",
      turnId: "t1",
      label: "before",
    });
    expect(parseCheckpointRef("refs/polaris/checkpoints/a/b/t9/after")?.sessionId).toBe("a/b");
    expect(parseCheckpointRef("refs/polaris/checkpoints/s1/t1/middle")).toBeNull();
    expect(parseCheckpointRef("refs/heads/main")).toBeNull();
  });

  test("a session that is not Archived keeps everything", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 3),
      sessions: [{ sessionId: "s1", archivedAt: null }],
      now: NOW,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.keep).toHaveLength(6);
    expect(plan.sessions.get("s1")).toBe("live");
  });

  test("a recently Archived session keeps everything (grace)", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 3),
      sessions: [archived("s1", DEFAULT_CHECKPOINT_POLICY.compactAfterMs - 1)],
      now: NOW,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.sessions.get("s1")).toBe("grace");
  });

  test("after the grace period only the first before and the last after stay", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 3),
      sessions: [archived("s1", 8 * DAY)],
      now: NOW,
    });

    expect(plan.sessions.get("s1")).toBe("compact");
    expect(plan.keep).toEqual([
      checkpointRef("s1", "t1", "before"),
      checkpointRef("s1", "t3", "after"),
    ]);
    expect(plan.delete).toHaveLength(4);
  });

  test("the engine's Turn order wins over checkpoint times", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 3),
      sessions: [archived("s1", 8 * DAY, { turnIds: ["t3", "t1", "t2"] })],
      now: NOW,
    });

    expect(plan.keep).toEqual([
      checkpointRef("s1", "t2", "after"),
      checkpointRef("s1", "t3", "before"),
    ]);
  });

  test("a Turn without an after (interrupted) still leaves the latest existing after", () => {
    const refs = refsFor("s1", 3).filter((r) => r.ref !== checkpointRef("s1", "t3", "after"));
    const plan = planCheckpointPrune({ refs, sessions: [archived("s1", 8 * DAY)], now: NOW });
    expect(plan.keep).toEqual([
      checkpointRef("s1", "t1", "before"),
      checkpointRef("s1", "t2", "after"),
    ]);
  });

  test("pinned Turns (forked from) survive compaction", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 4),
      sessions: [archived("s1", 8 * DAY, { pinnedTurnIds: ["t2"] })],
      now: NOW,
    });

    expect(plan.keep).toEqual([
      checkpointRef("s1", "t1", "before"),
      checkpointRef("s1", "t2", "after"),
      checkpointRef("s1", "t2", "before"),
      checkpointRef("s1", "t4", "after"),
    ]);
  });

  test("after the drop age everything goes", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 2),
      sessions: [archived("s1", 31 * DAY, { worktreeBranch: "polaris/s1" })],
      now: NOW,
      unmergedBranches: new Set(),
    });

    expect(plan.sessions.get("s1")).toBe("drop");
    expect(plan.keep).toEqual([]);
    expect(plan.delete).toHaveLength(4);
  });

  test("an unmerged Worktree branch protects the endpoints past the drop age", () => {
    const plan = planCheckpointPrune({
      refs: refsFor("s1", 3),
      sessions: [archived("s1", 90 * DAY, { worktreeBranch: "polaris/s1" })],
      now: NOW,
      unmergedBranches: new Set(["polaris/s1"]),
    });

    expect(plan.sessions.get("s1")).toBe("protected");
    expect(plan.keep).toEqual([
      checkpointRef("s1", "t1", "before"),
      checkpointRef("s1", "t3", "after"),
    ]);
  });

  test("orphans are kept unless pruneOrphans", () => {
    const input = { refs: refsFor("ghost", 1), sessions: [], now: NOW };
    const kept = planCheckpointPrune(input);
    expect(kept.sessions.get("ghost")).toBe("orphan");
    expect(kept.delete).toEqual([]);
    expect(planCheckpointPrune({ ...input, pruneOrphans: true }).delete).toHaveLength(2);
  });

  test("sessions are judged independently", () => {
    const plan = planCheckpointPrune({
      refs: [...refsFor("live", 2), ...refsFor("old", 2)],
      sessions: [{ sessionId: "live", archivedAt: null }, archived("old", 40 * DAY)],
      now: NOW,
    });

    expect(plan.delete.every((r) => r.includes("/old/"))).toBe(true);
    expect(plan.keep.every((r) => r.includes("/live/"))).toBe(true);
  });
});

describe("pruneCheckpoints in a real repository", () => {
  const capture = async (root: string, sessionId: string, turns: number) => {
    for (let n = 1; n <= turns; n++) {
      await captureCheckpoint({ cwd: root, sessionId, turnId: `t${n}`, label: "before" });
      write(root, `${sessionId}-${n}.txt`, `turn ${n}\n`);
      await captureCheckpoint({ cwd: root, sessionId, turnId: `t${n}`, label: "after" });
    }
  };

  test("compacts an Archived session and leaves a live one alone", async () => {
    const root = await repo();
    await capture(root, "old", 3);
    await capture(root, "live", 2);
    expect(await listCheckpointRefs(root)).toHaveLength(10);

    const report = await pruneCheckpoints(
      root,
      [
        { sessionId: "old", archivedAt: Date.now() - 8 * DAY, turnIds: ["t1", "t2", "t3"] },
        { sessionId: "live", archivedAt: null },
      ],
      {}
    );

    expect(report.deleted).toHaveLength(4);
    const left = (await listCheckpointRefs(root)).map((r) => r.ref).sort();
    expect(left).toEqual(
      [
        checkpointRef("live", "t1", "after"),
        checkpointRef("live", "t1", "before"),
        checkpointRef("live", "t2", "after"),
        checkpointRef("live", "t2", "before"),
        checkpointRef("old", "t1", "before"),
        checkpointRef("old", "t3", "after"),
      ].sort()
    );

    // The kept endpoints still give the whole session's diff.
    const diff = await gitText(root, [
      "diff",
      "--name-only",
      checkpointRef("old", "t1", "before"),
      checkpointRef("old", "t3", "after"),
    ]);

    expect(diff.split("\n")).toEqual(["old-1.txt", "old-2.txt", "old-3.txt"]);
  });

  test("a dry run deletes nothing", async () => {
    const root = await repo();
    await capture(root, "old", 2);

    const report = await pruneCheckpoints(
      root,
      [{ sessionId: "old", archivedAt: Date.now() - 40 * DAY }],
      { dryRun: true }
    );

    expect(report.deleted).toHaveLength(4);
    expect(await listCheckpointRefs(root)).toHaveLength(4);
  });

  test("an unmerged Worktree branch protects old checkpoints; merging it releases them", async () => {
    const root = await repo();
    const wt = join(dirname(root), `${basename(root)}-wt`);
    cleanup.push(wt);
    await gitText(root, ["worktree", "add", "-q", "-b", "polaris/s1", wt]);
    await capture(wt, "s1", 2);
    write(wt, "work.txt", "work\n");
    await commitAll(wt, "work");

    const session = {
      sessionId: "s1",
      archivedAt: Date.now() - 40 * DAY,
      worktreeBranch: "polaris/s1",
    };

    const protectedReport = await pruneCheckpoints(root, [session]);
    expect(protectedReport.sessions.get("s1")).toBe("protected");
    expect(await listCheckpointRefs(root)).toHaveLength(2);

    await gitText(root, ["merge", "-q", "--ff-only", "polaris/s1"]);
    const dropped = await pruneCheckpoints(root, [session]);
    expect(dropped.sessions.get("s1")).toBe("drop");
    expect(await listCheckpointRefs(root)).toHaveLength(0);
  });

  test("a deleted Worktree branch no longer protects", async () => {
    const root = await repo();
    await capture(root, "s1", 1);

    const report = await pruneCheckpoints(root, [
      { sessionId: "s1", archivedAt: Date.now() - 40 * DAY, worktreeBranch: "gone" },
    ]);

    expect(report.sessions.get("s1")).toBe("drop");
    expect(await listCheckpointRefs(root)).toHaveLength(0);
  });

  test("onSessionArchived touches only that session and respects the grace period", async () => {
    const root = await repo();
    await capture(root, "a", 3);
    await capture(root, "b", 1);
    const now = Date.now();

    const graced = await Effect.runPromise(
      onSessionArchived(root, { sessionId: "a", archivedAt: now })
    );

    expect(graced.delete).toEqual([]);

    const immediate = await Effect.runPromise(
      onSessionArchived(
        root,
        { sessionId: "a", archivedAt: now },
        { policy: { compactAfterMs: 0, dropAfterMs: 30 * DAY } }
      )
    );

    expect(immediate.delete).toHaveLength(4);
    const left = (await listCheckpointRefs(root)).map((r) => r.ref);
    expect(left.filter((r) => r.includes("/b/"))).toHaveLength(2);
    expect(left.filter((r) => r.includes("/a/"))).toHaveLength(2);
  });

  test("dropSessionCheckpoints removes one session's refs", async () => {
    const root = await repo();
    await capture(root, "a", 2);
    await capture(root, "b", 1);
    expect(await dropSessionCheckpoints(root, "a")).toHaveLength(4);
    expect((await listCheckpointRefs(root)).every((r) => r.sessionId === "b")).toBe(true);
  });

  test("the sweep skips a broken repository and prunes the rest", async () => {
    const root = await repo();
    await capture(root, "old", 1);

    const reports = await Effect.runPromise(
      sweepCheckpoints([
        { repoPath: join(root, "does-not-exist"), sessions: [archived("gone", 40 * DAY)] },
        { repoPath: root, sessions: [{ sessionId: "old", archivedAt: Date.now() - 40 * DAY }] },
      ])
    );

    expect(reports.map((r) => r.repoPath)).toEqual([root]);
    expect(await listCheckpointRefs(root)).toHaveLength(0);
  });

  // A missing repository makes any git the sweep runs fail, and say so.
  test.each([
    ["only live sessions", false, [{ sessionId: "live", archivedAt: null }], {}],
    ["no sessions", false, [], {}],
    ["an Archived session", true, [archived("old", 40 * DAY)], {}],
    ["orphans to prune", true, [], { pruneOrphans: true }],
  ] as const)("with %s the sweep runs git: %p", async (_, runsGit, sessions, options) => {
    const logs: Array<string> = [];
    const logger = Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)));

    const reports = await Effect.runPromise(
      sweepCheckpoints([{ repoPath: join(tmpdir(), "polaris-no-such-repo"), sessions }], {
        ...options,
        now: NOW,
      }).pipe(Effect.provide(Logger.layer([logger])))
    );

    expect(reports).toEqual([]);
    expect(logs.some((line) => line.includes("checkpoint prune of"))).toBe(runsGit);
  });

  test("the periodic sweeper runs at once and then on its interval", async () => {
    const root = await repo();
    await capture(root, "old", 1);
    let calls = 0;

    const fiber = Effect.runFork(
      runCheckpointSweeper({
        interval: "20 millis",
        targets: Effect.sync(() => {
          calls++;

          return [{ repoPath: root, sessions: [{ sessionId: "old", archivedAt: 0 }] }];
        }),
      })
    );

    while (calls < 3) await Bun.sleep(10);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(await listCheckpointRefs(root)).toHaveLength(0);
  });
});
