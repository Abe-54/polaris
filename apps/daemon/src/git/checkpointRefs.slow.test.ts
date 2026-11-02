import { expect, test } from "bun:test";
import { SessionId, TurnId } from "@polaris/protocol";
import { checkpointRef, parseCheckpointRef } from "./checkpointRefs.ts";
import { captureCheckpoint } from "./Checkpoints.ts";
import { computeDiff, DiffSpec } from "./diff.ts";
import { gitText, runGitRaw } from "./git.ts";
import { listCheckpointRefs, planCheckpointPrune } from "./prune.ts";
import { inspectCheckout } from "./review/worktree.ts";
import { makeRepo, removeDir, write } from "./testing.ts";

test("real Worker identities capture both checkpoints, support Turn diff and retain active checkpoints", async () => {
  const root = await makeRepo();
  const sessionId = SessionId.make("dispatch-1790915668002-1:T4:worker");
  const turnId = TurnId.make("dispatch-1790915668002-1:T4:attempt:start");

  try {
    await captureCheckpoint({ cwd: root, sessionId, turnId, label: "before" });
    write(root, "agent.txt", "agent edit\n");
    await captureCheckpoint({ cwd: root, sessionId, turnId, label: "after" });
    const diff = await computeDiff(root, DiffSpec.cases.Turn.make({ sessionId, turnId }));
    expect(diff.files).toBe(1);
    expect(new TextDecoder().decode(diff.bytes)).toContain("+agent edit");
    const refs = await listCheckpointRefs(root);
    expect(refs).toHaveLength(2);
    expect(refs.map((ref) => [ref.sessionId, ref.turnId])).toEqual([
      [sessionId, turnId],
      [sessionId, turnId],
    ]);

    const plan = planCheckpointPrune({
      refs,
      sessions: [{ sessionId, archivedAt: null }],
      now: Date.now(),
      pruneOrphans: true,
    });

    expect(plan.delete).toEqual([]);
    expect(plan.keep).toHaveLength(2);
  } finally {
    removeDir(root);
  }
});

test("unsafe IDs round-trip and produce valid Git refs without collisions or oversized components", async () => {
  const root = await makeRepo();

  try {
    for (const id of [
      "a:b",
      "a%3Ab",
      ".hidden",
      "name.lock",
      "a..b",
      "a@{b",
      "a\\b",
      "a b",
      "a\n",
      "a?b",
      "a[b",
      "a/b",
      "x".repeat(300),
      "💫:worker",
      "\ud800:worker",
    ]) {
      const ref = checkpointRef(id, `${id}:turn`, "before");
      expect((await runGitRaw(root, ["check-ref-format", ref])).code).toBe(0);
      expect(parseCheckpointRef(ref)).toEqual({
        sessionId: id,
        turnId: `${id}:turn`,
        label: "before",
      });
    }

    expect(checkpointRef("a:b", "turn", "before")).not.toBe(
      checkpointRef("a%3Ab", "turn", "before")
    );
    expect(parseCheckpointRef("refs/polaris/checkpoints-v2/zzzz/t/0000/before")).toBeNull();
    expect(parseCheckpointRef("refs/polaris/checkpoints-v2/0061/t/000/before")).toBeNull();
  } finally {
    removeDir(root);
  }
});

test("legacy valid checkpoints stay at their original path and pruning removes encoded archived refs", async () => {
  const root = await makeRepo();

  try {
    const legacy = checkpointRef("session-1", "turn-1", "before");
    expect(legacy).toBe("refs/polaris/checkpoints/session-1/turn-1/before");
    await captureCheckpoint({
      cwd: root,
      sessionId: "session-1",
      turnId: "turn-1",
      label: "before",
    });
    await captureCheckpoint({
      cwd: root,
      sessionId: "worker:1",
      turnId: "turn:1",
      label: "before",
    });
    const refs = await listCheckpointRefs(root);

    const plan = planCheckpointPrune({
      refs,
      sessions: [
        { sessionId: "session-1", archivedAt: null },
        { sessionId: "worker:1", archivedAt: 0 },
      ],
      now: 40 * 86400000,
    });

    expect(plan.keep).toEqual([legacy]);
    expect(plan.delete).toEqual([checkpointRef("worker:1", "turn:1", "before")]);
    await gitText(root, ["update-ref", "-d", plan.delete[0]!]);
    expect(await listCheckpointRefs(root)).toHaveLength(1);
  } finally {
    removeDir(root);
  }
});

test("Review checkout inspection excludes encoded checkpoint commits from user-owned work", async () => {
  const root = await makeRepo();

  try {
    write(root, "agent.txt", "checkpoint\n");

    const checkpoint = await captureCheckpoint({
      cwd: root,
      sessionId: "worker:1",
      turnId: "turn:1",
      label: "after",
    });

    if (checkpoint === null) throw new Error("Expected checkpoint");
    await gitText(root, ["checkout", "--detach", "--force", checkpoint.commit]);
    expect((await inspectCheckout(root, null)).localCommits).toBe(0);
  } finally {
    removeDir(root);
  }
});
