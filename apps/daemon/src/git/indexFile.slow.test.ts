/** `holdsNoGitlinks` on the index files git itself writes, in each layout it has. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { holdsNoGitlinks } from "./indexFile.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const d of dirs.splice(0)) removeTempDir(d);
});

const git = (cwd: string, ...args: Array<string>) => {
  const r = Bun.spawnSync(["git", ...args], { cwd });

  if (r.exitCode !== 0) throw new Error(r.stderr.toString());

  return r.stdout.toString().trim();
};

/** Tracked paths with the split index's signature in them, and one deep enough for a long name. */
const PATHS = [
  "docs/symlink.md",
  "link",
  "linkedDevices/list.ts",
  `linkedDevices/${"deeper/".repeat(30)}list.ts`,
  "z.txt",
];

const makeRepo = (format: "sha1" | "sha256") => {
  const repo = newTempDir("polaris-index-");
  dirs.push(repo);
  git(repo, "init", "-q", "-b", "main", `--object-format=${format}`);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");

  // Older than the index: a split index then has nothing to say about them in its own file.
  const past = Math.floor(Date.now() / 1000) - 10;

  for (const path of PATHS) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${path}\n`);
    utimesSync(join(repo, path), past, past);
  }

  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");

  return repo;
};

/** Stages a gitlink at `path` without a repository there: any commit's name will do. */
const addGitlink = (repo: string, path: string) =>
  git(
    repo,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(repo, "rev-parse", "HEAD")},${path}`
  );

const indexOf = (repo: string) => readFileSync(join(repo, ".git", "index"));

const version = (repo: string) => indexOf(repo).readUInt32BE(4);

const LAYOUTS: ReadonlyArray<readonly [string, number, (repo: string) => void]> = [
  ["version 2", 2, () => {}],
  [
    "version 3 (an intent-to-add entry has extended flags)",
    3,
    (repo) => {
      writeFileSync(join(repo, "a-intent.txt"), "later\n");
      git(repo, "add", "-N", "a-intent.txt");
    },
  ],
  ["version 4 (names compressed)", 4, (repo) => git(repo, "update-index", "--index-version", "4")],
  [
    "version 2 with an untracked cache",
    2,
    (repo) => {
      git(repo, "update-index", "--untracked-cache");
      git(repo, "status");
    },
  ],
];

describe.each(["sha1", "sha256"] as const)("git's own index files (%s)", (format) => {
  const hashBytes = format === "sha1" ? 20 : 32;

  test.each(LAYOUTS)("%s", (_, expected, prepare) => {
    const repo = makeRepo(format);
    prepare(repo);
    expect(version(repo)).toBe(expected);
    expect(holdsNoGitlinks(indexOf(repo), hashBytes)).toBe(true);

    // Sorted last, so every entry before it has to be stepped over exactly.
    addGitlink(repo, "zz/vendor");
    expect(version(repo)).toBe(expected);
    expect(holdsNoGitlinks(indexOf(repo), hashBytes)).toBe(false);
  });

  test("a gitlink sorted first and one between long names are found", () => {
    for (const path of ["a-first", `linkedDevices/${"deeper/".repeat(30)}aa`]) {
      const repo = makeRepo(format);
      git(repo, "update-index", "--index-version", "4");
      addGitlink(repo, path);
      expect(holdsNoGitlinks(indexOf(repo), hashBytes)).toBe(false);
    }
  });

  test("a split index may hold one: its entries, a gitlink too, are in the shared file", () => {
    const repo = makeRepo(format);
    addGitlink(repo, "zz/vendor");
    git(repo, "config", "core.splitIndex", "true");
    git(repo, "update-index", "--split-index");

    // No entry of its own to read a mode from: only the `link` extension says there are more.
    expect(indexOf(repo).readUInt32BE(8)).toBe(0);
    expect(holdsNoGitlinks(indexOf(repo), hashBytes)).toBe(false);
  });
});
