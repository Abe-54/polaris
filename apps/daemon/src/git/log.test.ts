import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { handleGitLog } from "./GitRpcs.ts";
import { gitText } from "./git.ts";
import { commitAll, makeRepo, removeDir, tempDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const repo = async (files?: Record<string, string>) => {
  const root = await makeRepo(files);
  cleanup.push(root);

  return root;
};

const log = (cwd: string, limit = 10) => Effect.runPromise(handleGitLog({ cwd, limit }));

test("answers the newest commits first with each one's subject, body, author and date", async () => {
  const root = await repo();
  write(root, "a.txt", "a\n");
  const message = "feat(ui): the Settings kit\n\nCards and wells.\n\nSigned-off-by: Test\n\n\n";
  const sha = await commitAll(root, message);

  const { commits } = await log(root);

  expect(commits.map((c) => c.subject)).toEqual(["feat(ui): the Settings kit", "initial"]);
  expect(commits[0]).toMatchObject({
    sha,
    body: "Cards and wells.\n\nSigned-off-by: Test",
    author: "Test",
  });
  expect(Number.isNaN(Date.parse(commits[0]!.date))).toBe(false);
  expect(commits[1]!.body).toBe("");
});

test("stops at the limit", async () => {
  const root = await repo();

  for (const n of [1, 2, 3]) {
    write(root, "n.txt", `${n}\n`);
    await commitAll(root, `commit ${n}`);
  }

  const { commits } = await log(root, 2);

  expect(commits.map((c) => c.subject)).toEqual(["commit 3", "commit 2"]);
});

test("an unborn branch has no commits", async () => {
  const root = await repo({});

  expect((await log(root)).commits).toEqual([]);
});

test("a linked worktree answers its own branch's commits", async () => {
  const root = await repo();
  const parent = tempDir("polaris-log-worktree-");
  cleanup.push(parent);
  const worktree = join(parent, "feature");
  await gitText(root, ["worktree", "add", "-q", "-b", "feature", worktree]);
  write(worktree, "f.txt", "f\n");
  await commitAll(worktree, "feat: only on the worktree");

  expect((await log(worktree, 1)).commits[0]?.subject).toBe("feat: only on the worktree");
  expect((await log(root, 1)).commits[0]?.subject).toBe("initial");
});

test("a folder outside any repository fails with GitError", async () => {
  const dir = tempDir("polaris-log-plain-");
  cleanup.push(dir);

  const error = await Effect.runPromise(Effect.flip(handleGitLog({ cwd: dir, limit: 1 })));

  expect(error._tag).toBe("GitError");
});
