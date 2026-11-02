import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitCommitItem } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { handleGitCommit, handleGitDiscard, handleGitStage, handleGitUnstage } from "./GitRpcs.ts";
import { posixTest } from "../platform/testing.ts";
import { gitText } from "./git.ts";
import { makeRepo, removeDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const repo = async (files?: Record<string, string>) => {
  const root = await makeRepo(files);
  cleanup.push(root);
  // The Host's global hooksPath would apply otherwise; tests use the repository's own.
  await gitText(root, ["config", "core.hooksPath", ".git/hooks"]);

  return root;
};

const status = (root: string) => gitText(root, ["status", "--porcelain=v1", "-uall"]);

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const hook = (root: string, name: string, script: string) => {
  write(root, `.git/hooks/${name}`, `#!/bin/sh\n${script}\n`);
  chmodSync(join(root, ".git", "hooks", name), 0o755);
};

const commitItems = (cwd: string, message: string) =>
  run(Stream.runCollect(handleGitCommit({ cwd, message }))).then(
    (items): ReadonlyArray<GitCommitItem> => [...items]
  );

const outputOf = (items: ReadonlyArray<GitCommitItem>) =>
  items.flatMap((i) => (GitCommitItem.guards.Output(i) ? [i.text] : [])).join("");

describe("git.stage / git.unstage", () => {
  test("stage takes edits, new files and deletions; unstage puts them back", async () => {
    const root = await repo({ "a.txt": "a\n", "b.txt": "b\n", "dir/c.txt": "c\n" });
    write(root, "a.txt", "changed\n");
    write(root, "new file.txt", "new\n");
    await gitText(root, ["rm", "-q", "--cached", "b.txt"]).then(() =>
      gitText(root, ["reset", "-q"])
    );
    removeDir(join(root, "b.txt"));

    await run(
      handleGitStage({ cwd: join(root, "dir"), paths: ["a.txt", "new file.txt", "b.txt"] })
    );
    expect(await status(root)).toBe('M  a.txt\nD  b.txt\nA  "new file.txt"');

    await run(handleGitUnstage({ cwd: root, paths: ["a.txt", "b.txt", "new file.txt"] }));
    expect(await status(root)).toBe(' M a.txt\n D b.txt\n?? "new file.txt"');
  });

  test("unstage works before the first commit", async () => {
    const root = await repo({});
    write(root, "first.txt", "1\n");
    await run(handleGitStage({ cwd: root, paths: ["first.txt"] }));
    expect(await status(root)).toBe("A  first.txt");
    await run(handleGitUnstage({ cwd: root, paths: ["first.txt"] }));
    expect(await status(root)).toBe("?? first.txt");
  });

  posixTest("a Windows file name can't hold `*`")(
    "paths are literal: a glob stages only the file of that name",
    async () => {
      const root = await repo({ "a.txt": "a\n" });
      write(root, "*.txt", "star\n");
      write(root, "a.txt", "changed\n");
      await run(handleGitStage({ cwd: root, paths: ["*.txt"] }));
      expect(await status(root)).toBe("A  *.txt\n M a.txt");
    }
  );
});

describe("git.discard", () => {
  test("puts a tracked file back to the index's version, keeping what's staged", async () => {
    const root = await repo({ "a.txt": "a\n" });
    write(root, "a.txt", "staged\n");
    await gitText(root, ["add", "a.txt"]);
    write(root, "a.txt", "staged then edited\n");
    await run(handleGitDiscard({ cwd: root, paths: ["a.txt"] }));
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("staged\n");
    expect(await status(root)).toBe("M  a.txt");
  });

  test("brings back a deleted file and refuses an untracked one", async () => {
    const root = await repo({ "a.txt": "a\n" });
    removeDir(join(root, "a.txt"));
    await run(handleGitDiscard({ cwd: root, paths: ["a.txt"] }));
    expect(existsSync(join(root, "a.txt"))).toBe(true);

    write(root, "loose.txt", "x\n");
    const error = await run(Effect.flip(handleGitDiscard({ cwd: root, paths: ["loose.txt"] })));
    expect(error._tag).toBe("GitError");
    expect(existsSync(join(root, "loose.txt"))).toBe(true);
  });
});

describe("git.commit", () => {
  test("commits the index, streaming the hook's output, then the new HEAD", async () => {
    const root = await repo({ "a.txt": "a\n" });
    hook(root, "pre-commit", 'echo "lint: 1 file"\necho "fmt ok" >&2');
    write(root, "a.txt", "b\n");
    write(root, "unstaged.txt", "left alone\n");
    await gitText(root, ["add", "a.txt"]);

    const items = await commitItems(root, "fix: one thing\n\nThe body.\n");
    const output = outputOf(items);
    const last = items.at(-1);

    expect(output).toContain("lint: 1 file");
    expect(output).toContain("fmt ok");
    expect(last).toEqual(
      GitCommitItem.cases.Committed.make({ head: await gitText(root, ["rev-parse", "HEAD"]) })
    );
    expect(await gitText(root, ["log", "-1", "--format=%B"])).toBe("fix: one thing\n\nThe body.\n");
    expect(await status(root)).toBe("?? unstaged.txt");
  });

  test("a failing hook ends with Failed and its output; nothing is committed", async () => {
    const root = await repo({ "a.txt": "a\n" });
    const before = await gitText(root, ["rev-parse", "HEAD"]);
    hook(root, "pre-commit", 'echo "a.ts:15:7  attempt is unused" >&2\nexit 1');
    write(root, "a.txt", "b\n");
    await gitText(root, ["add", "a.txt"]);

    const items = await commitItems(root, "fix: lint");
    const output = outputOf(items);

    expect(output).toContain("attempt is unused");
    expect(items.at(-1)).toEqual(GitCommitItem.cases.Failed.make({ exitCode: 1 }));
    expect(await gitText(root, ["rev-parse", "HEAD"])).toBe(before);
    expect(await status(root)).toBe("M  a.txt");
  });

  test("dropping the stream doesn't stop the commit", async () => {
    const root = await repo({ "a.txt": "a\n" });
    hook(root, "pre-commit", 'echo "slow hook"\nsleep 0.3');
    write(root, "a.txt", "b\n");
    await gitText(root, ["add", "a.txt"]);

    await run(Stream.runHead(handleGitCommit({ cwd: root, message: "keeps going" })));

    for (let i = 0; i < 40; i++) {
      if ((await gitText(root, ["log", "-1", "--format=%s"])) === "keeps going") break;
      await Bun.sleep(50);
    }

    expect(await gitText(root, ["log", "-1", "--format=%s"])).toBe("keeps going");
  });
});
