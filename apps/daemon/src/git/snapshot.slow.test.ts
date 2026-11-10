import { afterEach, expect, type Mock, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gitExecutable } from "./executable.ts";
import { snapshotWorkingTree } from "./snapshot.ts";
import { HEAVY_GIT_MS } from "./testing.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const dirs: Array<string> = [];

const spies: Array<Mock<typeof Bun.spawn>> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();

  for (const d of dirs.splice(0)) removeTempDir(d);
});

/** Watches every git the Daemon starts from here; answers how many ran with all of `words`. */
const countGits = (...words: Array<string>) => {
  const spawn = spyOn(Bun, "spawn");
  spies.push(spawn);

  return () =>
    spawn.mock.calls.filter(([command]) => {
      const argv = Array.isArray(command) ? command : [];

      return argv[0] === gitExecutable() && words.every((word) => argv.includes(word));
    }).length;
};

const git = (cwd: string, ...args: Array<string>) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });

  if (r.exitCode !== 0) throw new Error(r.stderr.toString());

  return r.stdout.toString().trim();
};

/** A whole second safely in the past, for mtimes that share it. */
const pastSecond = () => Math.floor(Date.now() / 1000) - 10;

test("a same-size edit in the same second as the last index write is still captured", async () => {
  const repo = newTempDir("polaris-racy-");
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
  const repo = newTempDir("polaris-snap-");
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

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
  const other = newTempDir("polaris-wt-");
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

test("tracked paths that hold `link` cost no listing of the index", async () => {
  const repo = makeRepo({ "linkedDevices/list.ts": "a\n", "docs/symlink.md": "b\n" });
  const listings = countGits("ls-files");
  writeFileSync(join(repo, "hyperlink.txt"), "c\n");
  const first = await snapshotWorkingTree(repo);
  writeFileSync(join(repo, "linked.txt"), "d\n");
  const second = await snapshotWorkingTree(repo);

  expect(filesOf(repo, first!.tree)).toEqual([
    "docs/symlink.md",
    "hyperlink.txt",
    "linkedDevices/list.ts",
  ]);
  expect(filesOf(repo, second!.tree)).toContain("linked.txt");
  expect(listings()).toBe(0);
});

/** A repository with a nested one staged as a gitlink at `sub`, which then moves to a new commit. */
const withMovedGitlink = (prepare: (repo: string) => void = () => {}) => {
  const repo = makeRepo({ "linkedDevices/list.ts": "a\n" });
  const sub = join(repo, "sub");
  mkdirSync(sub);
  git(sub, "init", "-q", "-b", "main");
  git(sub, "config", "user.email", "t@example.com");
  git(sub, "config", "user.name", "t");
  writeFileSync(join(sub, "s.txt"), "one\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-qm", "one");
  const recorded = git(sub, "rev-parse", "HEAD");
  git(repo, "add", "sub");
  git(repo, "commit", "-qm", "sub");
  prepare(repo);
  writeFileSync(join(sub, "s.txt"), "two\n");
  git(sub, "commit", "-qam", "two");

  return { repo, recorded };
};

const gitlinkOf = (repo: string, tree: string) => git(repo, "ls-tree", tree, "sub").split(/\s/)[2];

/** The user's index split, with every entry (the gitlink too) in its shared file. */
const splitIndex = (repo: string): void => {
  const past = pastSecond();
  utimesSync(join(repo, "linkedDevices/list.ts"), past, past);
  git(repo, "update-index", "--refresh");
  git(repo, "config", "core.splitIndex", "true");
  git(repo, "update-index", "--split-index");

  if (readFileSync(join(repo, ".git", "index")).readUInt32BE(8) !== 0) {
    throw new Error("the split index kept entries of its own");
  }
};

test.each([
  ["version 2", (): void => {}],
  ["version 4", (repo: string): void => void git(repo, "update-index", "--index-version", "4")],
  ["a split index", splitIndex],
] as const)(
  "a submodule keeps its recorded commit: %s",
  async (_, prepare) => {
    const { repo, recorded } = withMovedGitlink(prepare);
    const listings = countGits("ls-files");
    writeFileSync(join(repo, "new.txt"), "n\n");
    const first = await snapshotWorkingTree(repo);
    const second = await snapshotWorkingTree(repo);

    // `add -A` would stage the submodule's new HEAD (and run git inside it) unless it is excluded.
    expect(gitlinkOf(repo, first!.tree)).toBe(recorded);
    expect(gitlinkOf(repo, second!.tree)).toBe(recorded);
    expect(filesOf(repo, second!.tree)).toContain("new.txt");
    expect(listings()).toBe(2);
  },
  HEAVY_GIT_MS
);

test(
  "a tree gc pruned from under its own index is written again, not handed out",
  async () => {
    const repo = makeRepo({ "a.txt": "a\n" });
    const past = pastSecond();
    writeFileSync(join(repo, "b.txt"), "b\n");

    // Older than the index, so the next `add -A` trusts their stat and leaves the index alone.
    for (const name of ["a.txt", "b.txt"]) utimesSync(join(repo, name), past, past);
    const first = await snapshotWorkingTree(repo);
    git(repo, "gc", "-q", "--prune=now");
    expect(Bun.spawnSync(["git", "cat-file", "-e", first!.tree], { cwd: repo }).exitCode).not.toBe(
      0
    );

    const second = await snapshotWorkingTree(repo);
    expect(second!.tree).toBe(first!.tree);
    expect(git(repo, "show", `${second!.tree}:b.txt`)).toBe("b");
  },
  HEAVY_GIT_MS
);

test("a snapshot of an edited working tree starts no git to check its tree", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  await snapshotWorkingTree(repo);
  const checks = countGits("cat-file");
  writeFileSync(join(repo, "a.txt"), "edited\n");
  const snapshot = await snapshotWorkingTree(repo);

  expect(git(repo, "show", `${snapshot!.tree}:a.txt`)).toBe("edited");
  expect(checks()).toBe(0);
});

test("a submodule at a path that isn't UTF-8 is excluded like any other", async () => {
  const repo = makeRepo({ "a.txt": "a\n" });
  const head = git(repo, "rev-parse", "HEAD");
  // One byte per character: "café" as UTF-8, then as Latin-1, which is not UTF-8.
  const paths = ["caf\u00c3\u00a9", "caf\u00e9", "plain"];

  // Gitlinks in the index alone, no directory behind them: `add -A` drops one it isn't told to skip.
  const staged = Bun.spawnSync(["git", "update-index", "-z", "--index-info"], {
    cwd: repo,
    stdin: Buffer.from(paths.map((path) => `160000 ${head}\t${path}\0`).join(""), "latin1"),
  });

  expect(staged.exitCode).toBe(0);
  const snapshot = await snapshotWorkingTree(repo);

  const tree = Bun.spawnSync(["git", "ls-tree", "-z", "--name-only", snapshot!.tree], {
    cwd: repo,
  });

  expect(tree.stdout.toString("latin1").split("\0").filter(Boolean)).toEqual(["a.txt", ...paths]);
});
