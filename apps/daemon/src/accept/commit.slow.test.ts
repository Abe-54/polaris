/**
 * Committing, reverting and pushing accepted Turns on real repositories. Turns
 * are faked by capturing checkpoints around edits, as the engine does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TurnId } from "@polaris/protocol";
import { captureCheckpoint } from "../git/Checkpoints.ts";
import { gitText } from "../git/git.ts";
import { makeRepo, removeDir, tempDir, write } from "../git/testing.ts";
import { currentBranch, defaultBranch, diffStat, pushRemote } from "./branch.ts";
import { type CheckpointedTurn, CommitRefused, commitTurns, committedTurnIds } from "./commit.ts";
import { pushBranch } from "./push.ts";
import { revertLaterTurns } from "./revert.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const SESSION = "s1";

/** Each test runs 60-100 real gits, a few hundred ms here but near bun's 5 s default on a busy runner. */
const GIT_WORK_MS = 15_000;

/** Runs `edit` as Turn `index`, between its before- and after-checkpoints. */
const turn = async (root: string, index: number, edit: () => void): Promise<CheckpointedTurn> => {
  const turnId = TurnId.make(`t${index}`);
  const options = { cwd: root, sessionId: SESSION, turnId };
  const before = await captureCheckpoint({ ...options, label: "before" });
  edit();
  const after = await captureCheckpoint({ ...options, label: "after" });

  return { turnId, index, before: before!.commit, after: after!.commit };
};

const repo = async () => {
  const root = await makeRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
  cleanup.push(root);

  return root;
};

const log = (root: string) => gitText(root, ["log", "--format=%s", "-n", "5"]);

const status = (root: string) => gitText(root, ["status", "--porcelain"]);

describe("commitTurns", () => {
  test(
    "one commit of the Turns' own changes; the working tree and the user's edits are kept",
    async () => {
      const root = await repo();
      write(root, "mine.txt", "the user's own\n");
      const t0 = await turn(root, 0, () => write(root, "a.txt", "two\n"));
      const t1 = await turn(root, 1, () => write(root, "new.txt", "created\n"));
      await turn(root, 2, () => write(root, "b.txt", "later\n"));

      const commits = await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0, t1], message: "Add new and change a\n\nBody.\n" }],
        createBranch: null,
      });

      expect(commits).toHaveLength(1);
      expect(await log(root)).toBe("Add new and change a\ninitial");
      expect(await gitText(root, ["show", "--name-only", "--format=", "HEAD"])).toBe(
        "a.txt\nnew.txt"
      );
      // Turn 2 and the user's file stay uncommitted, nothing is staged.
      expect((await status(root)).split("\n").sort()).toEqual([" M b.txt", "?? mine.txt"]);
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("later\n");
      expect([...(await committedTurnIds(root, SESSION))].sort()).toEqual(["t0", "t1"]);
    },
    GIT_WORK_MS
  );

  test(
    "one commit per Turn, on a new branch checked out in place",
    async () => {
      const root = await repo();
      const t0 = await turn(root, 0, () => write(root, "a.txt", "two\n"));
      const t1 = await turn(root, 1, () => write(root, "b.txt", "bee two\n"));

      const commits = await commitTurns({
        root,
        sessionId: SESSION,
        groups: [
          { turns: [t0], message: "Change a\n" },
          { turns: [t1], message: "Change b\n" },
        ],
        createBranch: "polaris/change-both",
      });

      expect(commits).toHaveLength(2);
      expect(await currentBranch(root)).toBe("polaris/change-both");
      expect(await log(root)).toBe("Change b\nChange a\ninitial");
      expect(await gitText(root, ["rev-parse", "main"])).not.toBe(commits[1]);
      expect(await status(root)).toBe("");
    },
    GIT_WORK_MS
  );

  test(
    "a Turn that changed nothing makes no commit",
    async () => {
      const root = await repo();
      const t0 = await turn(root, 0, () => {});

      const commits = await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0], message: "Nothing\n" }],
        createBranch: null,
      });

      expect(commits).toEqual([]);
      expect(await log(root)).toBe("initial");
    },
    GIT_WORK_MS
  );

  test(
    "a failing hook leaves no branch behind and HEAD where it was",
    async () => {
      const root = await repo();
      write(root, ".git/hooks/pre-commit", "#!/bin/sh\necho no >&2\nexit 1\n");
      chmodSync(join(root, ".git/hooks/pre-commit"), 0o755);
      const t0 = await turn(root, 0, () => write(root, "a.txt", "two\n"));

      const failure = await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0], message: "Change a\n" }],
        createBranch: "polaris/x",
      }).catch((error: Error) => error);

      expect(failure).toBeInstanceOf(CommitRefused);
      expect(await currentBranch(root)).toBe("main");
      expect(await gitText(root, ["branch", "--list", "polaris/x"])).toBe("");
      expect(await committedTurnIds(root, SESSION)).toEqual(new Set());
    },
    GIT_WORK_MS
  );

  test(
    "changes on top of the user's own edits to the same file merge in three ways",
    async () => {
      const root = await makeRepo({ "a.txt": "1\n2\n3\n4\n5\n6\n7\n8\n9\n" });
      cleanup.push(root);
      write(root, "a.txt", "1 user\n2\n3\n4\n5\n6\n7\n8\n9\n");

      const t0 = await turn(root, 0, () =>
        write(root, "a.txt", "1 user\n2\n3\n4\n5\n6\n7\n8\n9 agent\n")
      );

      await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0], message: "Agent edit\n" }],
        createBranch: null,
      });

      expect(await gitText(root, ["show", "HEAD:a.txt"])).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9 agent");
      expect(await status(root)).toBe(" M a.txt");
    },
    GIT_WORK_MS
  );
});

describe("a Turn editing a file HEAD doesn't have", () => {
  test(
    "commits the file whole, as the Turn left it",
    async () => {
      const root = await repo();
      write(root, "notes.txt", "another session's file\n");
      const t0 = await turn(root, 0, () => write(root, "notes.txt", "rewritten by this one\n"));

      await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0], message: "Rewrite the notes\n" }],
        createBranch: null,
      });

      expect(await gitText(root, ["show", "HEAD:notes.txt"])).toBe("rewritten by this one");
      expect(await status(root)).toBe("");
    },
    GIT_WORK_MS
  );
});

describe("revertLaterTurns", () => {
  test(
    "restores what later Turns changed and deletes what they created",
    async () => {
      const root = await repo();
      const t0 = await turn(root, 0, () => write(root, "a.txt", "two\n"));

      const t1 = await turn(root, 1, () => {
        write(root, "a.txt", "three\n");
        write(root, "created.txt", "x\n");
      });

      write(root, "untouched.txt", "kept\n");

      const touched = await revertLaterTurns(root, t0.after, [t1]);

      expect([...touched].sort()).toEqual(["a.txt", "created.txt"]);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("two\n");
      expect(existsSync(join(root, "created.txt"))).toBe(false);
      expect(readFileSync(join(root, "untouched.txt"), "utf8")).toBe("kept\n");
    },
    GIT_WORK_MS
  );
});

describe("branch, remote and push", () => {
  test(
    "pushes to the remote and reads its default branch",
    async () => {
      const root = await repo();
      const remote = tempDir("polaris-remote-");
      cleanup.push(remote);
      await gitText(remote, ["init", "-q", "--bare", "-b", "main"]);
      await gitText(root, ["remote", "add", "origin", remote]);
      await gitText(root, ["push", "-q", "origin", "main"]);
      await gitText(root, ["remote", "set-head", "origin", "main"]);
      const t0 = await turn(root, 0, () => write(root, "a.txt", "two\n"));
      await commitTurns({
        root,
        sessionId: SESSION,
        groups: [{ turns: [t0], message: "Change a\n" }],
        createBranch: "polaris/a",
      });

      const target = await pushRemote(root, "polaris/a");
      expect(target).toEqual({ name: "origin", url: remote });
      expect(await defaultBranch(root, "origin")).toBe("main");
      await pushBranch(root, target!, "polaris/a");

      expect(await gitText(remote, ["log", "--format=%s", "polaris/a"])).toBe("Change a\ninitial");
      expect(await gitText(root, ["config", "branch.polaris/a.remote"])).toBe("origin");
      expect(await diffStat(root, t0.before, t0.after)).toEqual({
        files: 1,
        additions: 1,
        deletions: 1,
      });
    },
    GIT_WORK_MS
  );

  test(
    "a push git refuses fails with git's words",
    async () => {
      const root = await repo();
      await gitText(root, ["remote", "add", "origin", join(root, "nowhere")]);

      const failure = await pushBranch(root, { name: "origin", url: "x" }, "main").catch(
        (error: Error) => error
      );

      expect(String(failure)).toMatch(/git push to origin failed/);
    },
    GIT_WORK_MS
  );
});
