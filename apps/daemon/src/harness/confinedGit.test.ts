import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGitRaw } from "../git/git.ts";
import { removeTempDir, tempDir } from "../git/testing.ts";
import { sanitizedConfig } from "./confinedGit.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

/** What git itself reads from a generated config: its keys and values, or null if it refuses it. */
const readByGit = async (config: string) => {
  const dir = tempDir("polaris-confined-config-");
  cleanup.push(dir);
  writeFileSync(join(dir, "config"), config);

  const listed = await runGitRaw(dir, ["config", "--file", join(dir, "config"), "--list", "-z"]);

  if (listed.code !== 0) return null;

  return new TextDecoder()
    .decode(listed.stdout)
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => entry.split("\n")[0]);
};

const ALLOWED = [
  "core.bare",
  "core.worktree",
  "core.excludesfile",
  "core.attributesfile",
  "core.repositoryformatversion",
];

// Unescaped, each path would close the quoted value and git would read the key after it.
test.each([
  ["a quote", '/tmp/pr"\n[core]\n\tfsmonitor = /tmp/evil\n#'],
  ["a backslash before a quote", '/tmp/pr\\"\n\tsshCommand = /tmp/evil\n#'],
])(
  "a checkout path with %s and new lines can't add a key: git refuses the config",
  async (_, worktree) => {
    expect(
      await readByGit(sanitizedConfig("core.repositoryformatversion\n0\0", worktree))
    ).toBeNull();
  }
);

test("an ordinary checkout path leaves only the allowlisted keys", async () => {
  const keys = await readByGit(sanitizedConfig("core.repositoryformatversion\n0\0", "/tmp/pr 7"));

  expect(keys).toEqual(ALLOWED);
});

test("a format key whose value carries a new line or section is dropped, not copied", async () => {
  const listed = [
    "core.repositoryformatversion\n1\n[core]\n\tfsmonitor = /tmp/evil",
    'extensions.objectformat\nsha256\n[remote "origin"]\n\turl = https://x:token@h/r',
    "extensions.refstorage\nfiles",
    "",
  ].join("\0");

  const config = sanitizedConfig(listed, "/tmp/pr-7");
  const keys = await readByGit(config);

  expect(keys).toEqual([
    "core.bare",
    "core.worktree",
    "core.excludesfile",
    "core.attributesfile",
    "extensions.refstorage",
  ]);
  expect(config).not.toContain("token");
});
