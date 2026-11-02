import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { type WorktreeInfo, WorktreeTracker } from "../services.ts";
import { gitText, runGitRaw } from "./git.ts";
import { commitAll, makeRepo, removeDir, tempDir, write } from "./testing.ts";
import { parseWorktreeList, watchWorktrees, WorktreeTrackerLive } from "./WorktreeTracker.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const run = <A, E>(effect: Effect.Effect<A, E, WorktreeTracker>) =>
  Effect.runPromise(effect.pipe(Effect.provide(WorktreeTrackerLive)));

const withTracker = <A, E>(f: (t: WorktreeTracker["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* WorktreeTracker);
  });

const branchExists = async (root: string, branch: string) =>
  (await runGitRaw(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

describe("WorktreeTracker", () => {
  test("parses porcelain output with detached and locked worktrees", () => {
    const out = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /elsewhere/wt",
      "HEAD bbb",
      "detached",
      "locked",
      "",
      "worktree /repo.worktrees/.review/pr-7",
      "HEAD ccc",
      "detached",
      "locked polaris review checkout ws #7",
      "",
      "",
    ].join("\0");

    expect(parseWorktreeList(out)).toEqual([
      { path: "/repo", head: "aaa", branch: "main", isMain: true },
      { path: "/elsewhere/wt", head: "bbb", branch: null, isMain: false, lockReason: "" },
      {
        path: "/repo.worktrees/.review/pr-7",
        head: "ccc",
        branch: null,
        isMain: false,
        lockReason: "polaris review checkout ws #7",
      },
    ]);
  });

  test("create adds a new branch from baseRef; remove keeps the branch", async () => {
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside);
    const path = join(outside, "project-wt", "feature");

    const created = await run(
      Effect.gen(function* () {
        const tracker = yield* WorktreeTracker;

        return yield* tracker.create({ repoPath: root, path, branch: "feature", baseRef: "main" });
      })
    );

    expect(created).toMatchObject({ path, branch: "feature", isMain: false });
    expect(existsSync(join(path, "README.md"))).toBe(true);

    const list = await run(withTracker((t) => t.list(root)));
    expect(list.map((w) => w.branch)).toEqual(["main", "feature"]);

    await run(withTracker((t) => t.remove({ repoPath: root, path, deleteBranchIfMerged: false })));
    expect(existsSync(path)).toBe(false);
    expect(await branchExists(root, "feature")).toBe(true);
  });

  test("create never runs a husky-style post-checkout hook from the checked-out commit", async () => {
    const markers = tempDir("polaris-marker-");
    const marker = join(markers, "hook-ran");
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside, markers);
    // Forward slashes: Git for Windows runs hooks through sh.
    write(root, ".husky/post-checkout", `#!/bin/sh\necho ran >> ${marker.replaceAll("\\", "/")}\n`);
    chmodSync(join(root, ".husky/post-checkout"), 0o755);
    await commitAll(root, "husky");
    await gitText(root, ["config", "core.hooksPath", ".husky"]);
    await gitText(root, ["branch", "existing"]);

    await run(
      withTracker((t) =>
        Effect.all([
          t.create({ repoPath: root, path: join(outside, "new"), branch: "new", baseRef: "main" }),
          t.create({
            repoPath: root,
            path: join(outside, "existing"),
            branch: "existing",
            baseRef: null,
          }),
        ])
      )
    );

    expect(existsSync(join(outside, "existing", ".husky/post-checkout"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("remove deletes a merged branch only when asked, and never an unmerged one", async () => {
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside);

    const tracker = (f: (t: WorktreeTracker["Service"]) => Effect.Effect<unknown, unknown>) =>
      run(withTracker(f));

    // Merged (no new commits): deleted when deleteBranchIfMerged.
    const merged = join(outside, "merged");
    await tracker((t) =>
      t.create({ repoPath: root, path: merged, branch: "merged", baseRef: null })
    );
    await tracker((t) => t.remove({ repoPath: root, path: merged, deleteBranchIfMerged: true }));
    expect(await branchExists(root, "merged")).toBe(false);

    // Unmerged (a commit only on the branch): kept even when deleteBranchIfMerged.
    const unmerged = join(outside, "unmerged");
    await tracker((t) =>
      t.create({ repoPath: root, path: unmerged, branch: "unmerged", baseRef: null })
    );
    write(unmerged, "work.txt", "work\n");
    await commitAll(unmerged, "work");
    await tracker((t) => t.remove({ repoPath: root, path: unmerged, deleteBranchIfMerged: true }));
    expect(existsSync(unmerged)).toBe(false);
    expect(await branchExists(root, "unmerged")).toBe(true);
  });

  test("on Linux each worktree gets a shallow watch that sees its HEAD move", async () => {
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside);
    const external = join(outside, "external");
    const opened: Array<{ path: string; recursive: boolean }> = [];
    const seen: Array<ReadonlyArray<WorktreeInfo>> = [];

    const waitFor = async (predicate: (list: ReadonlyArray<WorktreeInfo>) => boolean) => {
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        if (seen.some(predicate)) return;
        await Bun.sleep(25);
      }

      throw new Error(`timed out; saw ${JSON.stringify(seen)}`);
    };

    const fiber = Effect.runFork(
      watchWorktrees(root, {
        platform: "linux",
        open: (path, recursive, changed) => {
          opened.push({ path, recursive });

          return watch(path, { recursive: false }, changed);
        },
      }).pipe(Stream.runForEach((list) => Effect.sync(() => seen.push(list))))
    );

    try {
      await waitFor((list) => list.length === 1);
      await gitText(root, ["worktree", "add", "-q", "-b", "ext", external]);
      await waitFor((list) => list.some((w) => w.branch === "ext"));
      await gitText(external, ["switch", "-q", "-c", "moved"]);
      await waitFor((list) => list.some((w) => w.branch === "moved"));
      expect(opened.some((o) => o.path.endsWith(join("worktrees", "external")))).toBe(true);
      expect(opened.every((o) => !o.recursive)).toBe(true);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("a watch that reports its own deleted directory without end still lets the list settle", async () => {
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside);
    const external = join(outside, "external");
    const seen: Array<ReadonlyArray<WorktreeInfo>> = [];

    const waitFor = async (predicate: (list: ReadonlyArray<WorktreeInfo>) => boolean) => {
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        if (seen.some(predicate)) return;
        await Bun.sleep(25);
      }

      throw new Error(`timed out; saw ${JSON.stringify(seen)}`);
    };

    const fiber = Effect.runFork(
      watchWorktrees(root, {
        platform: "darwin",
        // As Bun's recursive watch does on Windows once `worktrees/` is gone: no error, no end.
        open: (path, recursive, changed) => {
          const watcher = watch(path, { recursive }, changed);
          const emit = watcher.emit.bind(watcher);
          watcher.emit = (event: string | symbol, ...args: Array<unknown>) =>
            event !== "error" && emit(event, ...args);
          const spin = setInterval(() => existsSync(path) || changed(), 2);
          watcher.on("close", () => clearInterval(spin));

          return watcher;
        },
      }).pipe(Stream.runForEach((list) => Effect.sync(() => seen.push(list))))
    );

    try {
      await waitFor((list) => list.length === 1);
      await gitText(root, ["worktree", "add", "-q", "-b", "ext", external]);
      await waitFor((list) => list.some((w) => w.branch === "ext"));
      await gitText(root, ["worktree", "remove", external]);
      const count = seen.length;
      await waitFor((list) => seen.indexOf(list) >= count && list.length === 1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });

  test("watch detects a worktree created and removed outside Polaris", async () => {
    const root = await makeRepo();
    const outside = tempDir("polaris-wt-");
    cleanup.push(root, outside);
    const external = join(outside, "external");

    const seen: Array<ReadonlyArray<WorktreeInfo>> = [];

    const waitFor = async (predicate: (list: ReadonlyArray<WorktreeInfo>) => boolean) => {
      const deadline = Date.now() + 5000;

      while (Date.now() < deadline) {
        if (seen.some(predicate)) return;
        await Bun.sleep(25);
      }

      throw new Error(`timed out; saw ${JSON.stringify(seen)}`);
    };

    const fiber = Effect.runFork(
      withTracker((t) =>
        t.watch(root).pipe(Stream.runForEach((list) => Effect.sync(() => seen.push(list))))
      ).pipe(Effect.provide(WorktreeTrackerLive))
    );

    try {
      await waitFor((list) => list.length === 1);
      // Created by the user's own git, not through the tracker.
      await gitText(root, ["worktree", "add", "-q", "-b", "ext", external]);
      await waitFor((list) => list.some((w) => w.branch === "ext"));
      await gitText(root, ["worktree", "remove", external]);
      const count = seen.length;
      await waitFor((list) => seen.indexOf(list) >= count && list.length === 1);
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
    }
  });
});
