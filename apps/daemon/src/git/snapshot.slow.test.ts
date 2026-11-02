import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { snapshotWorkingTree } from "./snapshot.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });

  if (r.exitCode !== 0) throw new Error(r.stderr.toString());

  return r.stdout.toString().trim();
};

/** A whole second safely in the past, for mtimes that share it. */
const pastSecond = () => Math.floor(Date.now() / 1000) - 10;

test("a same-size edit in the same second as the last index write is still captured", async () => {
  const repo = mkdtempSync(join(tmpdir(), "polaris-racy-"));
  dirs.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  const file = join(repo, "a.txt");

  // The commit and the same-size edit share second `past`, and so does the index write:
  // git can then only tell the file changed through its racy-clean check.
  const past = pastSecond();
  writeFileSync(file, "one\n");
  utimesSync(file, past, past);
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "init");
  writeFileSync(file, "two\n");
  utimesSync(file, past, past);
  utimesSync(join(repo, ".git", "index"), past, past);

  // The snapshot runs seconds later, so an index copy with a fresh mtime would miss the edit.
  const snapshot = await snapshotWorkingTree(repo);
  expect(snapshot?.tree).not.toBe(git(repo, "rev-parse", "HEAD^{tree}"));
});

const makeRepo = (files: Record<string, string>) => {
  const repo = mkdtempSync(join(tmpdir(), "polaris-snap-"));
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");

  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  return repo;
};

const filesOf = (repo: string, tree: string) =>
  git(repo, "ls-tree", "-r", "--name-only", tree).split("\n").filter(Boolean).sort();

const ownIndex = (repo: string) => join(repo, ".git", "polaris", "index");

test("keeps its own index between snapshots and never writes the user's", async () => {
  const repo = makeRepo({ "a.txt": "a\n", ".gitignore": "*.log\n" });
  const userIndex = readFileSync(join(repo, ".git", "index"));
  const first = await snapshotWorkingTree(repo);
  expect(existsSync(ownIndex(repo))).toBe(true);
  expect(first?.tree).toBe(git(repo, "rev-parse", "HEAD^{tree}"));

  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  writeFileSync(join(repo, "noise.log"), "ignored\n");
  const second = await snapshotWorkingTree(repo);
  expect(filesOf(repo, second!.tree)).toEqual([".gitignore", "a.txt", "new.txt"]);
  expect(git(repo, "show", `${second!.tree}:a.txt`)).toBe("changed");

  rmSync(join(repo, "new.txt"));
  const third = await snapshotWorkingTree(repo);
  expect(filesOf(repo, third!.tree)).toEqual([".gitignore", "a.txt"]);
  expect(readFileSync(join(repo, ".git", "index")).equals(userIndex)).toBe(true);
  expect(git(repo, "status", "--porcelain")).toBe("M a.txt");
});

test("a same-size edit in the same second as its own index's last write is still captured", async () => {
  const repo = makeRepo({ "a.txt": "zero\n" });
  const past = pastSecond();
  writeFileSync(join(repo, "a.txt"), "one\n");
  utimesSync(join(repo, "a.txt"), past, past);
  const first = await snapshotWorkingTree(repo);
  // The edit and the own index's last write share second `past`; the next snapshot is later.
  writeFileSync(join(repo, "a.txt"), "two\n");
  utimesSync(join(repo, "a.txt"), past, past);
  utimesSync(ownIndex(repo), past, past);
  const second = await snapshotWorkingTree(repo);
  expect(git(repo, "show", `${first!.tree}:a.txt`)).toBe("one");
  expect(git(repo, "show", `${second!.tree}:a.txt`)).toBe("two");
});

test("follows the user's index for which ignored files are tracked", async () => {
  const repo = makeRepo({ "a.txt": "a\n", ".gitignore": "*.log\n" });
  writeFileSync(join(repo, "kept.log"), "forced\n");
  expect(filesOf(repo, (await snapshotWorkingTree(repo))!.tree)).not.toContain("kept.log");
  git(repo, "add", "-f", "kept.log");
  expect(filesOf(repo, (await snapshotWorkingTree(repo))!.tree)).toContain("kept.log");
  git(repo, "rm", "-q", "--cached", "kept.log");
  expect(filesOf(repo, (await snapshotWorkingTree(repo))!.tree)).not.toContain("kept.log");
});

test("a corrupt own index falls back to a fresh copy and is rebuilt", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  await snapshotWorkingTree(repo);
  writeFileSync(ownIndex(repo), "not an index");
  writeFileSync(join(repo, "b.txt"), "b\n");
  const snapshot = await snapshotWorkingTree(repo);
  expect(filesOf(repo, snapshot!.tree)).toEqual(["a.txt", "b.txt"]);
  const again = await snapshotWorkingTree(repo);
  expect(again!.tree).toBe(snapshot!.tree);
  expect(readFileSync(ownIndex(repo)).subarray(0, 4).toString()).toBe("DIRC");
});

test("each worktree has its own index", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const other = mkdtempSync(join(tmpdir(), "polaris-wt-"));
  dirs.push(other);
  rmSync(other, { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "side", other);
  writeFileSync(join(other, "side.txt"), "side\n");
  const main = await snapshotWorkingTree(repo);
  const side = await snapshotWorkingTree(other);
  expect(filesOf(repo, main!.tree)).toEqual(["a.txt"]);
  expect(filesOf(repo, side!.tree)).toEqual(["a.txt", "side.txt"]);
  const sideIndex = join(repo, ".git", "worktrees", basename(other), "polaris", "index");
  expect(existsSync(sideIndex)).toBe(true);
});

test("a user's split index is read but never split or expired by our writes", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  git(repo, "config", "core.splitIndex", "true");
  git(repo, "update-index", "--split-index");

  const shared = () =>
    readdirSync(join(repo, ".git"))
      .filter((name) => name.startsWith("sharedindex."))
      .sort();

  const before = shared();
  expect(before.length).toBe(1);
  writeFileSync(join(repo, "b.txt"), "b\n");
  const first = await snapshotWorkingTree(repo);
  writeFileSync(join(repo, "c.txt"), "c\n");
  const second = await snapshotWorkingTree(repo);
  expect(filesOf(repo, first!.tree)).toEqual(["a.txt", "b.txt"]);
  expect(filesOf(repo, second!.tree)).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(shared()).toEqual(before);
  expect(git(repo, "status", "--porcelain")).toBe("?? b.txt\n?? c.txt");
});

test("concurrent snapshots of one repository agree", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  writeFileSync(join(repo, "b.txt"), "b\n");
  const trees = await Promise.all([1, 2, 3, 4].map(() => snapshotWorkingTree(repo)));
  expect(new Set(trees.map((s) => s!.tree)).size).toBe(1);
});
