import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitText, resolveCommit, runGitRaw } from "../git.ts";
import { commitAll, removeTempDir, tempDir, write } from "../testing.ts";
import { listWorktrees } from "../WorktreeTracker.ts";
import { fetchPullRequest } from "./fetch.ts";
import { lockReasonFor, reviewRef } from "./refs.ts";
import {
  BASE_REPO,
  contributor,
  createForge,
  lines,
  publishPullRequest,
  pushMain,
  userClone,
} from "./testing.ts";
import {
  ensureCheckout,
  inspectCheckout,
  isReviewCheckoutWorktree,
  moveCheckout,
  removeCheckout,
} from "./worktree.ts";

// Each test runs tens of real gits: past bun's 5 s default on a loaded runner (as commit.slow.test.ts).
setDefaultTimeout(15_000);

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

/** A PR that adds a husky-style `post-checkout` hook writing `marker`, and a user with husky set up. */
const setup = async () => {
  const forge = await createForge();
  cleanup.push(forge.root);
  const markers = tempDir("polaris-marker-");
  cleanup.push(markers);
  const marker = join(markers, "hook-ran");
  const author = await contributor(forge, "main");
  // Forward slashes: Git for Windows runs hooks through sh.
  write(author, ".husky/post-checkout", `#!/bin/sh\necho ran >> ${marker.replaceAll("\\", "/")}\n`);
  chmodSync(join(author, ".husky/post-checkout"), 0o755);
  write(author, ".gitignore", "node_modules/\n");
  write(author, "feature.txt", "v1\n");
  await commitAll(author, "feature v1");
  const v1 = await publishPullRequest(forge, author, 7);
  const user = await userClone(forge);
  cleanup.push(user, `${user}.worktrees`);
  await gitText(user, ["config", "core.hooksPath", ".husky"], { config: "host" });
  await fetchFor(user);
  const path = join(`${user}.worktrees`, ".review", "pr-7");

  return { forge, author, user, path, marker, v1 };
};

const fetchFor = (user: string) =>
  fetchPullRequest({
    repoPath: user,
    trusted: false,
    key: "7",
    repo: BASE_REPO,
    number: 7,
    baseRef: "main",
    baseCommit: "",
    unshallow: false,
  });

/** The author pushes v2 and the user fetches it. */
const nextVersion = async (setupResult: Awaited<ReturnType<typeof setup>>) => {
  write(setupResult.author, "feature.txt", "v2\n");
  await commitAll(setupResult.author, "feature v2");
  await publishPullRequest(setupResult.forge, setupResult.author, 7);

  return (await fetchFor(setupResult.user)).head;
};

describe("Review Checkout worktree", () => {
  test("is detached and locked, leaves the user's tree alone, and never runs the PR's hooks", async () => {
    const s = await setup();
    write(s.user, "app.txt", "the user's own edit\n");
    const userHead = await gitText(s.user, ["rev-parse", "HEAD"]);

    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: lockReasonFor("ws #7"),
    });

    const listed = (await listWorktrees(s.user)).find((w) => w.path === s.path);
    expect(listed).toMatchObject({
      branch: null,
      head: s.v1,
      lockReason: "polaris review checkout ws #7",
    });
    expect(listed && isReviewCheckoutWorktree(listed)).toBe(true);
    expect(await gitText(s.user, ["rev-parse", "HEAD"])).toBe(userHead);
    expect(await gitText(s.user, ["status", "--porcelain"])).toBe(" M app.txt");
    expect(await gitText(s.user, ["branch", "--format=%(refname:short)"])).toBe("main");

    await moveCheckout({ path: s.path, head: await nextVersion(s), discardChanges: false });
    expect(existsSync(s.marker)).toBe(false);

    // The control: with the Host's config as it is, the PR's own hook runs in the checkout.
    await gitText(s.path, ["checkout", "-q", "--detach", s.v1], { config: "host" });
    expect(existsSync(s.marker)).toBe(true);
  });

  test("ensure is idempotent, and recreates a checkout whose directory was deleted", async () => {
    const s = await setup();
    const options = { repoPath: s.user, path: s.path, head: s.v1, lockReason: lockReasonFor("#7") };
    await ensureCheckout(options);
    await ensureCheckout(options);
    rmSync(s.path, { recursive: true, force: true });

    await ensureCheckout(options);

    expect(await resolveCommit(s.path, "HEAD")).toBe(s.v1);
    expect((await listWorktrees(s.user)).filter((w) => w.path === s.path)).toHaveLength(1);
  });

  test("inspect reports edits and untracked files, not ignored ones, and commits of its own", async () => {
    const s = await setup();
    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: "polaris review checkout",
    });
    expect(await inspectCheckout(s.path, s.v1)).toEqual({
      present: true,
      dirtyPaths: [],
      localCommits: 0,
    });
    // After a force-push the old head is held by nothing but the checkout: still not the user's.
    await gitText(s.user, ["update-ref", "-d", reviewRef("7", "head")]);
    expect(await inspectCheckout(s.path, s.v1)).toMatchObject({ localCommits: 0 });
    expect(await inspectCheckout(s.path, null)).toMatchObject({ localCommits: 1 });

    write(s.path, "node_modules/dep/index.js", "ignored\n");
    write(s.path, "feature.txt", "edited\n");
    write(s.path, "scratch.txt", "new\n");
    expect(await inspectCheckout(s.path, s.v1)).toEqual({
      present: true,
      dirtyPaths: ["feature.txt", "scratch.txt"],
      localCommits: 0,
    });

    await commitAll(s.path, "a local fix");
    await gitText(s.path, ["commit", "-q", "--allow-empty", "-m", "another"]);
    expect(await inspectCheckout(s.path, s.v1)).toEqual({
      present: true,
      dirtyPaths: [],
      localCommits: 2,
    });
    expect(await inspectCheckout(join(s.path, "missing"), null)).toMatchObject({ present: false });
  });

  test("discarding changes resets and cleans, keeping ignored files", async () => {
    const s = await setup();
    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: "polaris review checkout",
    });
    write(s.path, "node_modules/dep/index.js", "installed\n");
    write(s.path, "feature.txt", "edited\n");
    write(s.path, "scratch.txt", "new\n");
    const v2 = await nextVersion(s);

    await moveCheckout({ path: s.path, head: v2, discardChanges: true });

    expect(await resolveCommit(s.path, "HEAD")).toBe(v2);
    expect(await inspectCheckout(s.path, s.v1)).toMatchObject({ dirtyPaths: [] });
    expect(existsSync(join(s.path, "node_modules/dep/index.js"))).toBe(true);
    expect(existsSync(s.marker)).toBe(false);
  });

  test("remove unlocks, removes the worktree and deletes the review refs", async () => {
    const s = await setup();
    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: "polaris review checkout",
    });
    write(s.path, "node_modules/dep/index.js", "installed\n");

    await removeCheckout({ repoPath: s.user, path: s.path, key: "7" });

    expect(existsSync(s.path)).toBe(false);
    expect((await listWorktrees(s.user)).map((w) => w.path)).toEqual([s.user]);
    expect(await resolveCommit(s.user, reviewRef("7", "head"))).toBeNull();
    expect(await resolveCommit(s.user, reviewRef("7", "base"))).toBeNull();
  });

  test("a dirty checkout is refused by git and stays locked", async () => {
    const s = await setup();
    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: "polaris review checkout",
    });
    write(s.path, "scratch.txt", "new\n");

    const refused = await removeCheckout({ repoPath: s.user, path: s.path, key: "7" }).then(
      () => null,
      String
    );

    expect(refused).toContain("git worktree remove failed");

    expect(existsSync(join(s.path, "scratch.txt"))).toBe(true);
    expect((await listWorktrees(s.user)).find((w) => w.path === s.path)?.lockReason).toBe(
      "polaris review checkout"
    );
  });

  test("a checkout deleted by hand is pruned from git's registry on removal", async () => {
    const s = await setup();
    await ensureCheckout({
      repoPath: s.user,
      path: s.path,
      head: s.v1,
      lockReason: "polaris review checkout",
    });
    rmSync(s.path, { recursive: true, force: true });

    await removeCheckout({ repoPath: s.user, path: s.path, key: "7" });

    expect((await listWorktrees(s.user)).map((w) => w.path)).toEqual([s.user]);
    expect((await runGitRaw(s.user, ["worktree", "prune", "--dry-run", "-v"])).stderr).toBe("");
  });
});

describe("Review Checkout in a partial clone", () => {
  test.each(["blob:none", "tree:0"])(
    "a %s clone checks out a pull request on older history, never running the remote's upload-pack",
    async (filter) => {
      const forge = await createForge();
      cleanup.push(forge.root);
      const author = await contributor(forge, forge.mainCommits[0] ?? "main");
      write(author, "feature.txt", "v1\n");
      await commitAll(author, "feature v1");
      const head = await publishPullRequest(forge, author, 7);
      // The user's clone never fetched the PR's `app.txt`: `main` changed it since.
      await pushMain(forge, "app.txt", "moved on\n");
      const user = await userClone(forge, { filter });
      // The runner's global autocrlf would check the Review Checkout out with CRLF.
      await gitText(user, ["config", "core.autocrlf", "false"]);
      const markers = tempDir("polaris-marker-");
      cleanup.push(user, `${user}.worktrees`, markers);
      write(
        markers,
        "pack.sh",
        `#!/bin/sh\ntouch "${markers.replaceAll("\\", "/")}/ran"\nexec git-upload-pack "$@"\n`
      );
      chmodSync(join(markers, "pack.sh"), 0o755);
      await gitText(user, [
        "config",
        "remote.origin.uploadpack",
        join(markers, "pack.sh").replaceAll("\\", "/"),
      ]);
      const path = join(`${user}.worktrees`, ".review", "pr-7");

      const fetched = await fetchFor(user);
      await ensureCheckout({ repoPath: user, path, head, lockReason: lockReasonFor("#7") });

      expect(fetched.head).toBe(head);
      expect(readFileSync(join(path, "app.txt"), "utf8")).toBe(lines(10));
      expect(readFileSync(join(path, "feature.txt"), "utf8")).toBe("v1\n");
      expect(existsSync(join(markers, "ran"))).toBe(false);
    }
  );
});
