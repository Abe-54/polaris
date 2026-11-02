/**
 * The shared-checkout check before a revert, on real repositories: other
 * sessions' Turns are faked by capturing checkpoints around edits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { captureCheckpoint } from "../git/Checkpoints.ts";
import { makeRepo, removeDir, tempDir, write } from "../git/testing.ts";
import { conflictReason, contains, type OtherSession, revertConflicts } from "./shared.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const ME = SessionId.make("s-me");

const OTHER = SessionId.make("s-other");

const ACCEPTED_AT = "2026-10-11T10:00:00.000Z";

const LATER = "2026-10-11T11:00:00.000Z";

const repo = async () => {
  const root = await makeRepo({ "a.txt": "one\n", "b.txt": "bee\n" });
  cleanup.push(root);

  return root;
};

/** A Turn of OTHER's that ran `edit`, ended at `endedAt` (null: still running). */
const otherTurn = async (root: string, id: string, edit: () => void, endedAt: string | null) => {
  const options = { cwd: root, sessionId: OTHER, turnId: id };
  const before = await captureCheckpoint({ ...options, label: "before" });
  edit();
  const after = endedAt === null ? null : await captureCheckpoint({ ...options, label: "after" });

  return { checkpointBefore: before!.ref, checkpointAfter: after?.ref ?? null, endedAt };
};

const other = (
  cwd: string,
  turns: OtherSession["turns"],
  title = "Fix the login"
): OtherSession => ({ session: { id: OTHER, title, cwd }, turns });

const check = (root: string, paths: ReadonlyArray<string>, sessions: Array<OtherSession>) =>
  revertConflicts({ root, sessionId: ME, after: ACCEPTED_AT, paths: new Set(paths), sessions });

describe("revertConflicts", () => {
  test("another session in the same directory that changed a restored file refuses", async () => {
    const root = await repo();
    const turn = await otherTurn(root, "o1", () => write(root, "a.txt", "theirs\n"), LATER);

    const conflicts = await check(root, ["a.txt"], [other(root, [turn])]);

    expect(conflicts).toEqual([{ sessionId: OTHER, title: "Fix the login", paths: ["a.txt"] }]);
  });

  test("disjoint files are allowed", async () => {
    const root = await repo();
    const turn = await otherTurn(root, "o1", () => write(root, "b.txt", "theirs\n"), LATER);

    expect(await check(root, ["a.txt"], [other(root, [turn])])).toEqual([]);
  });

  test("a session alone in its directory is unchanged", async () => {
    const root = await repo();
    const mine = { session: { id: ME, title: "Mine", cwd: root }, turns: [] };

    expect(await check(root, ["a.txt"], [mine])).toEqual([]);
  });

  test("Turns that ended before the accepted one are left out", async () => {
    const root = await repo();
    const earlier = "2026-10-11T09:00:00.000Z";
    const turn = await otherTurn(root, "o1", () => write(root, "a.txt", "theirs\n"), earlier);

    expect(await check(root, ["a.txt"], [other(root, [turn])])).toEqual([]);
  });

  test("a running Turn counts its edits so far, untracked files included", async () => {
    const root = await repo();
    const turn = await otherTurn(root, "o1", () => write(root, "new.txt", "theirs\n"), null);

    const conflicts = await check(root, ["new.txt"], [other(root, [turn])]);

    expect(conflicts.map((c) => c.paths)).toEqual([["new.txt"]]);
  });

  test("a nested or enclosing directory is shared; a sibling isn't", async () => {
    const root = await repo();
    const turn = await otherTurn(root, "o1", () => write(root, "a.txt", "theirs\n"), LATER);
    const sibling = tempDir();
    cleanup.push(sibling);
    mkdirSync(join(root, "pkg"));

    expect(await check(root, ["a.txt"], [other(join(root, "pkg"), [turn])])).toHaveLength(1);
    expect(await check(join(root, "pkg"), ["a.txt"], [other(root, [turn])])).toHaveLength(1);
    expect(await check(root, ["a.txt"], [other(sibling, [turn])])).toEqual([]);
  });

  test("a symlink to the same directory is shared", async () => {
    const root = await repo();
    const turn = await otherTurn(root, "o1", () => write(root, "a.txt", "theirs\n"), LATER);
    const link = join(tempDir(), "alias");
    cleanup.push(join(link, ".."));
    symlinkSync(root, link);

    expect(await check(root, ["a.txt"], [other(link, [turn])])).toHaveLength(1);
  });

  test("a Turn without a checkpoint refuses, since its files can't be read", async () => {
    const root = await repo();
    const turn = { checkpointBefore: null, checkpointAfter: null, endedAt: LATER };

    expect(await check(root, ["a.txt"], [other(root, [turn])])).toEqual([
      { sessionId: OTHER, title: "Fix the login", paths: [] },
    ]);
  });
});

describe("conflictReason", () => {
  test("names the session and up to three files, and what to do instead", () => {
    const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];

    expect(conflictReason([{ sessionId: OTHER, title: "Fix the login", paths }])).toBe(
      'another Agent Session in this checkout changed files the revert would restore ("Fix the login": a.ts, b.ts, c.ts and 2 more); accept without reverting the later Turns, or run the sessions in separate Worktrees'
    );
    expect(conflictReason([])).toBeNull();
  });

  test("an unreadable session says so", () => {
    expect(conflictReason([{ sessionId: OTHER, title: "", paths: [] }])).toContain(
      `("Untitled", whose changes can't be read)`
    );
  });
});

test("contains", () => {
  expect(contains("/a/b", "/a/b")).toBe(true);
  expect(contains("/a/b", "/a/b/c")).toBe(true);
  expect(contains("/a/b", "/a/bc")).toBe(false);
  expect(contains("/a/b", "/a")).toBe(false);
});
