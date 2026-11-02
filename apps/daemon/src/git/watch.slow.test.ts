import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Layer, Queue, Stream } from "effect";
import { RpcTest } from "effect/rpc";
import { makeFakeBlobChannel } from "../files/testing.ts";
import { gitText } from "./git.ts";
import { GitRpcs, GitRpcsLive } from "./GitRpcs.ts";
import { gitStatus } from "./status.ts";
import { makeRepo, removeDir, tempDir, write } from "./testing.ts";
import { gitDirsOf, watchGitState } from "./watch.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

/** Watches `cwd` and counts changes; `settled` waits out stray events from setup. */
const watching = async (cwd: string) => {
  let count = 0;
  const stop = watchGitState(await gitDirsOf(cwd), () => count++);
  cleanup.push(stop);
  await Bun.sleep(150);
  count = 0;
  // Changes since the last `next`: on Windows they arrive while the git call is still running.
  let seen = 0;

  return {
    count: () => count,
    /** Resolves true once a change has arrived, false after `ms` without one. */
    next: async (ms = 3000) => {
      for (let waited = 0; waited < ms && count === seen; waited += 20) await Bun.sleep(20);

      const arrived = count > seen;
      seen = count;

      return arrived;
    },
  };
};

const repo = async () => {
  const root = await makeRepo({ "a.txt": "one\n", "b.txt": "one\n" });
  cleanup.push(() => removeDir(root));

  return root;
};

describe("watchGitState", () => {
  // Each of these changes `git status` without touching the working tree's files.
  test.each([
    ["git add", ["add", "a.txt"]],
    ["git commit", ["commit", "-qam", "two"]],
    ["git reset", ["reset", "-q", "a.txt"]],
    ["git checkout -b", ["checkout", "-qb", "other"]],
  ])("an external %s is seen", async (_name, args) => {
    const root = await repo();
    write(root, "a.txt", "two\n");
    await gitText(root, ["add", "a.txt"]);
    write(root, "a.txt", "three\n");
    const watch = await watching(root);

    await gitText(root, args);

    expect(await watch.next()).toBe(true);
  });

  test("an external git fetch that brings commits is seen, so behind moves", async () => {
    const root = await repo();
    const bare = tempDir("polaris-bare-");
    const parent = tempDir("polaris-other-");
    cleanup.push(() => removeDir(bare));
    cleanup.push(() => removeDir(parent));
    await gitText(bare, ["init", "-q", "--bare", "-b", "main"]);
    await gitText(root, ["remote", "add", "origin", bare]);
    await gitText(root, ["push", "-q", "-u", "origin", "main"]);
    const other = join(parent, "clone");
    await gitText(parent, ["clone", "-q", bare, other]);

    const who = [
      "-c",
      "user.name=O",
      "-c",
      "user.email=o@example.com",
      "-c",
      "commit.gpgsign=false",
    ];

    await gitText(other, [...who, "commit", "-q", "--allow-empty", "-m", "theirs"]);
    await gitText(other, ["push", "-q", "origin", "main"]);
    const watch = await watching(root);

    await gitText(root, ["fetch", "-q", "origin"]);

    expect(await watch.next()).toBe(true);
    expect((await gitStatus(root)).behind).toBe(1);
  });

  test("git stash, which moves the index and HEAD's reflog, is seen", async () => {
    const root = await repo();
    write(root, "a.txt", "two\n");
    await gitText(root, ["add", "a.txt"]);
    const watch = await watching(root);

    await gitText(root, ["stash", "-q"]);

    expect(await watch.next()).toBe(true);
  });

  test("the Daemon's own git.status doesn't count, or each refetch would set off the next", async () => {
    const root = await repo();
    write(root, "a.txt", "two\n");
    // Same content, older mtime: the index's stat is stale, so a locking status would rewrite it.
    utimesSync(join(root, "b.txt"), 1_000_000, 1_000_000);
    const watch = await watching(root);

    await gitStatus(root);

    expect(await watch.next(400)).toBe(false);
  });

  test("a linked worktree's git dir, outside its root, is watched", async () => {
    const root = await repo();
    const linked = join(tempDir("polaris-linked-"), "wt");
    cleanup.push(() => removeDir(join(linked, "..")));
    await gitText(root, ["worktree", "add", "-q", linked]);
    write(linked, "a.txt", "two\n");
    const watch = await watching(linked);

    await gitText(linked, ["add", "a.txt"]);

    expect(await watch.next()).toBe(true);
  });

  test("a Workspace in a subfolder of the repository is watched", async () => {
    const root = await repo();
    mkdirSync(join(root, "pkg"));
    const watch = await watching(join(root, "pkg"));

    write(root, "a.txt", "two\n");
    await gitText(root, ["add", "a.txt"]);

    expect(await watch.next()).toBe(true);
  });

  test("the first commit in a fresh repository arms HEAD's reflog", async () => {
    const root = await makeRepo({});
    cleanup.push(() => removeDir(root));
    write(root, "a.txt", "one\n");
    await gitText(root, ["add", "a.txt"]);
    await gitText(root, ["commit", "-qm", "first"]);
    const watch = await watching(root);

    // Only HEAD's reflog and the branch ref move on an empty commit.
    await gitText(root, ["commit", "-q", "--allow-empty", "-m", "second"]);

    expect(await watch.next()).toBe(true);
  });

  test("stopping releases the watch", async () => {
    const root = await repo();
    const watch = await watching(root);
    cleanup.pop()?.();

    write(root, "a.txt", "two\n");
    await gitText(root, ["add", "a.txt"]);

    expect(await watch.next(400)).toBe(false);
  });
});

describe("git.watch", () => {
  const handlers = GitRpcsLive.pipe(Layer.provide(makeFakeBlobChannel().layer));

  test("streams an item after an external git add", async () => {
    const root = await repo();
    write(root, "a.txt", "two\n");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(GitRpcs);
          const items = yield* client["git.watch"]({ cwd: root }, { asQueue: true });
          yield* Effect.sleep("200 millis");
          yield* Effect.promise(() => gitText(root, ["add", "a.txt"]));

          return yield* Queue.take(items).pipe(Effect.timeout("3 seconds"));
        }).pipe(Effect.provide(handlers))
      )
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("fails outside a git checkout", async () => {
    const plain = tempDir("polaris-plain-");
    cleanup.push(() => removeDir(plain));

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(GitRpcs);

          return yield* client["git.watch"]({ cwd: plain }).pipe(
            Stream.runHead,
            Effect.timeout("3 seconds")
          );
        }).pipe(Effect.provide(handlers))
      )
    );

    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("GitError");
  });
});
