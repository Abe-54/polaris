import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { makeFakeBlobChannel } from "../files/testing.ts";
import { Checkpoints } from "../services.ts";
import { CheckpointsLive, captureCheckpoint, checkpointRef } from "./Checkpoints.ts";
import { computeDiff, DiffSpec } from "./diff.ts";
import { handleGitDiff, handleGitStatus } from "./GitRpcs.ts";
import { findRepoRoot, gitText, mayBeInWorkTree, runGitRaw } from "./git.ts";
import { parsePorcelainV2 } from "./status.ts";
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

const sessionId = SessionId.make("s1");

const turnId = TurnId.make("t1");

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("mayBeInWorkTree", () => {
  test("finds .git upwards (a directory, or a worktree's file) and nothing outside repos", async () => {
    const root = await repo({ "a.txt": "a\n" });
    write(root, "deep/er/file.txt", "x\n");
    expect(mayBeInWorkTree(root)).toBe(true);
    expect(mayBeInWorkTree(join(root, "deep", "er"))).toBe(true);
    const worktree = join(tempDir(), "wt");
    cleanup.push(worktree);
    await gitText(root, ["worktree", "add", "-q", "-b", "side", worktree]);
    expect(mayBeInWorkTree(worktree)).toBe(true);
    // git prints the long name of an 8.3 one (C:\\Users\\RUNNER~1) on Windows.
    expect(await findRepoRoot(worktree)).toBe(realpathSync.native(worktree));
    const outside = tempDir();
    cleanup.push(outside);
    expect(mayBeInWorkTree(outside)).toBe(false);
    expect(await findRepoRoot(outside)).toBeNull();
  });
});

describe("git.status", () => {
  test("parses porcelain v2 with renames, conflicts and untracked files", () => {
    const out = [
      "# branch.oid 0123456789abcdef0123456789abcdef01234567",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaa bbb a file.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
      "old name.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt",
      "? untracked dir/x.ts",
      "",
    ].join("\0");

    const status = parsePorcelainV2(out);
    expect(status.branch).toBe("main");
    expect(status.head).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(status.ahead).toBe(2);
    expect(status.behind).toBe(3);
    expect(status.entries).toEqual([
      { path: "a file.txt", origPath: null, index: ".", worktree: "M" },
      { path: "new name.txt", origPath: "old name.txt", index: "R", worktree: "." },
      { path: "both.txt", origPath: null, index: "U", worktree: "U" },
      { path: "untracked dir/x.ts", origPath: null, index: "?", worktree: "?" },
    ]);
  });

  test("reports branch, head and entries of a real repository", async () => {
    const root = await repo({ "a.txt": "a\n", "b.txt": "b\n" });
    write(root, "a.txt", "changed\n");
    write(root, "new.txt", "new\n");
    await gitText(root, ["rm", "-q", "b.txt"]);
    const status = await Effect.runPromise(handleGitStatus({ cwd: root }));
    expect(status.branch).toBe("main");
    expect(status.head).toBe(await gitText(root, ["rev-parse", "HEAD"]));
    expect(status.ahead).toBe(0);

    const byPath = Object.fromEntries(
      status.entries.map((e) => [e.path, `${e.index}${e.worktree}`])
    );

    expect(byPath).toEqual({ "a.txt": ".M", "b.txt": "D.", "new.txt": "??" });
  });

  test("lists ignored paths only when asked, an ignored folder as one entry", async () => {
    const root = await repo({ ".gitignore": "*.log\nnode_modules/\n", "a.txt": "a\n" });
    write(root, "debug.log", "x\n");
    write(root, "node_modules/pkg/index.js", "x\n");
    write(root, "node_modules/pkg/lib/deep.js", "x\n");

    const plain = await Effect.runPromise(handleGitStatus({ cwd: root }));
    expect(plain.entries).toEqual([]);

    const status = await Effect.runPromise(handleGitStatus({ cwd: root, ignored: true }));

    expect(status.entries.map((e) => `${e.index}${e.worktree} ${e.path}`).sort()).toEqual([
      "!! debug.log",
      "!! node_modules/",
    ]);
  });

  test("fails with GitError outside a repository", async () => {
    const dir = tempDir();
    cleanup.push(dir);
    const error = await Effect.runPromise(Effect.flip(handleGitStatus({ cwd: dir })));
    expect(error._tag).toBe("GitError");
  });
});

describe("Checkpoints", () => {
  test("captures tracked and untracked files without touching the index, HEAD or branch", async () => {
    const root = await repo({ "tracked.txt": "v1\n", ".gitignore": "ignored.log\n" });
    write(root, "tracked.txt", "v2\n");
    write(root, "staged.txt", "staged\n");
    await gitText(root, ["add", "staged.txt"]);
    write(root, "untracked.txt", "untracked\n");
    write(root, "ignored.log", "secret\n");

    const indexPath = join(root, ".git", "index");
    const indexBefore = readFileSync(indexPath);
    const headBefore = await gitText(root, ["rev-parse", "HEAD"]);
    const statusBefore = await gitText(root, ["status", "--porcelain=v2"]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const checkpoints = yield* Checkpoints;

        return yield* checkpoints.capture({ cwd: root, sessionId, turnId, label: "before" });
      }).pipe(Effect.provide(CheckpointsLive))
    );

    expect(result).not.toBeNull();
    expect(result!.ref).toBe("refs/polaris/checkpoints/s1/t1/before");
    expect(await gitText(root, ["rev-parse", result!.ref])).toBe(result!.commit);
    expect(await gitText(root, ["rev-parse", `${result!.commit}^`])).toBe(headBefore);

    const files = (await gitText(root, ["ls-tree", "-r", "--name-only", result!.commit])).split(
      "\n"
    );

    expect(files.sort()).toEqual([".gitignore", "staged.txt", "tracked.txt", "untracked.txt"]);
    expect(await gitText(root, ["show", `${result!.commit}:tracked.txt`])).toBe("v2");

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(await gitText(root, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await gitText(root, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(await gitText(root, ["status", "--porcelain=v2"])).toBe(statusBefore);
  });

  test("works in a subdirectory and on an unborn branch", async () => {
    const root = await repo({});
    write(root, "sub/file.txt", "x\n");

    const result = await captureCheckpoint({
      cwd: join(root, "sub"),
      sessionId,
      turnId,
      label: "after",
    });

    expect(result).not.toBeNull();
    expect(await gitText(root, ["ls-tree", "-r", "--name-only", result!.commit])).toBe(
      "sub/file.txt"
    );
    // No parent on an unborn branch.
    expect(await gitText(root, ["rev-list", "--count", result!.commit])).toBe("1");
  });

  test("reuses the previous commit for an identical snapshot, and not otherwise", async () => {
    const root = await repo({ "a.txt": "one\n" });

    const capture = (turn: string, label: "before" | "after") =>
      captureCheckpoint({ cwd: root, sessionId, turnId: turn, label });

    const after1 = await capture("t1", "after");
    const before2 = await capture("t2", "before");
    expect(before2!.commit).toBe(after1!.commit);
    expect(await gitText(root, ["rev-parse", checkpointRef(sessionId, "t2", "before")])).toBe(
      after1!.commit
    );

    write(root, "a.txt", "two\n");
    const after2 = await capture("t2", "after");
    expect(after2!.commit).not.toBe(before2!.commit);

    // HEAD moved: same tree, different parent, so a new commit.
    await commitAll(root, "two");
    const before3 = await capture("t3", "before");
    expect(before3!.commit).not.toBe(after2!.commit);
    expect(await gitText(root, ["rev-parse", `${before3!.commit}^`])).toBe(
      await gitText(root, ["rev-parse", "HEAD"])
    );
  });

  test("writes a new commit when the reused one was pruned", async () => {
    const root = await repo({ "a.txt": "one\n" });
    write(root, "b.txt", "b\n");
    const first = await captureCheckpoint({ cwd: root, sessionId, turnId, label: "after" });
    await gitText(root, ["update-ref", "-d", first!.ref]);
    await gitText(root, ["reflog", "expire", "--expire=now", "--all"]);
    await gitText(root, ["gc", "-q", "--prune=now"]);
    expect((await runGitRaw(root, ["cat-file", "-e", first!.commit])).code).not.toBe(0);
    const next = await captureCheckpoint({ cwd: root, sessionId, turnId: "t2", label: "before" });
    expect(next!.commit).not.toBe(first!.commit);
    expect(await gitText(root, ["rev-parse", next!.ref])).toBe(next!.commit);
  });

  test("returns null outside a git repository", async () => {
    const dir = tempDir();
    cleanup.push(dir);
    expect(await captureCheckpoint({ cwd: dir, sessionId, turnId, label: "before" })).toBeNull();
  });
});

describe("git.diff", () => {
  test("WorkingTree includes untracked files and excludes ignored ones", async () => {
    const root = await repo({ "a.txt": "one\n", ".gitignore": "*.log\n" });
    write(root, "a.txt", "two\n");
    write(root, "fresh.txt", "brand new\n");
    write(root, "noise.log", "ignored\n");
    const diff = await computeDiff(root, DiffSpec.cases.WorkingTree.make({ base: null }));
    const text = decode(diff.bytes);
    expect(diff.files).toBe(2);
    expect(text).toContain("diff --git a/a.txt b/a.txt");
    expect(text).toContain("+two");
    expect(text).toContain("diff --git a/fresh.txt b/fresh.txt");
    expect(text).not.toContain("noise.log");
  });

  test("WorkingTree against an explicit base", async () => {
    const root = await repo({ "a.txt": "one\n" });
    const first = await gitText(root, ["rev-parse", "HEAD"]);
    write(root, "b.txt", "b\n");
    await commitAll(root, "second");
    const diff = await computeDiff(root, DiffSpec.cases.WorkingTree.make({ base: first }));
    expect(decode(diff.bytes)).toContain("b/b.txt");
    expect(diff.files).toBe(1);
  });

  test("Turn diffs between the before and after checkpoints", async () => {
    const root = await repo({ "a.txt": "one\n" });
    await captureCheckpoint({ cwd: root, sessionId, turnId, label: "before" });
    write(root, "a.txt", "agent edit\n");
    write(root, "added.txt", "added\n");
    await captureCheckpoint({ cwd: root, sessionId, turnId, label: "after" });
    write(root, "later.txt", "after the turn\n");
    const diff = await computeDiff(root, DiffSpec.cases.Turn.make({ sessionId, turnId }));
    const text = decode(diff.bytes);
    expect(diff.files).toBe(2);
    expect(text).toContain("+agent edit");
    expect(text).not.toContain("later.txt");
  });

  test("Range and the handler deliver the diff through the BlobChannel", async () => {
    const root = await repo({ "a.txt": "one\n" });
    const base = await gitText(root, ["rev-parse", "HEAD"]);
    write(root, "a.txt", "two\n");
    const head = await commitAll(root, "two");
    const blobs = makeFakeBlobChannel();

    const result = await Effect.runPromise(
      handleGitDiff({ cwd: root, spec: DiffSpec.cases.Range.make({ base, head }) }).pipe(
        Effect.provide(blobs.layer)
      )
    );

    expect(result.files).toBe(1);
    const bytes = blobs.blobs.get(result.blobId)!;
    expect(bytes.byteLength).toBe(result.size);
    expect(decode(bytes)).toContain("-one\n+two");
  });

  test("a missing Turn checkpoint is NotFound", async () => {
    const root = await repo();
    const blobs = makeFakeBlobChannel();

    const error = await Effect.runPromise(
      Effect.flip(
        handleGitDiff({
          cwd: root,
          spec: DiffSpec.cases.Turn.make({ sessionId, turnId: TurnId.make("nope") }),
        })
      ).pipe(Effect.provide(Layer.merge(blobs.layer, Layer.empty)))
    );

    expect(error._tag).toBe("NotFound");
    expect(checkpointRef(sessionId, "nope", "before")).toBe(
      "refs/polaris/checkpoints/s1/nope/before"
    );
  });
});
