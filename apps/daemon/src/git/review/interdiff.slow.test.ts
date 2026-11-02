import { afterEach, describe, expect, test } from "bun:test";
import { gitText, resolveCommit } from "../git.ts";
import { commitAll, removeDir, write } from "../testing.ts";
import { fetchPullRequest } from "./fetch.ts";
import { interdiff, markReviewed } from "./interdiff.ts";
import { reviewRef } from "./refs.ts";
import {
  BASE_REPO,
  contributor,
  lines,
  createForge,
  publishPullRequest,
  pushMain,
  userClone,
} from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

/** A PR that changes line 7 of app.txt, fetched and marked reviewed. */
const setup = async () => {
  const forge = await createForge();
  cleanup.push(forge.root);
  const author = await contributor(forge, "main");
  write(author, "app.txt", lines(10, { 7: "line 7 pr" }));
  await commitAll(author, "pr: line 7");
  await publishPullRequest(forge, author, 7);
  const user = await userClone(forge);
  cleanup.push(user);

  const fetch = () =>
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

  const reviewed = await fetch();
  await markReviewed({ repoPath: user, key: "7", ...reviewed });

  /** Publish the author's branch as the PR and diff it against the reviewed version. */
  const update = async (forceFallback: boolean) => {
    await publishPullRequest(forge, author, 7);
    const { head } = await fetch();

    const result = await interdiff({
      repoPath: user,
      reviewed: reviewed.head,
      reviewedBase: reviewed.mergeBase,
      head,
      base: reviewRef("7", "base"),
      forceFallback,
    });

    const changed = result.from === null ? null : await gitText(user, ["diff", result.from, head]);

    return { ...result, changed };
  };

  return { forge, author, user, reviewed, update };
};

describe.each([
  ["merge-tree", false],
  ["private index (git < 2.40)", true],
])("interdiff with %s", (_, forceFallback) => {
  test("a new commit on top is a fast-forward: just that commit", async () => {
    const s = await setup();
    write(s.author, "f1.txt", "one more\n");
    await commitAll(s.author, "f1");

    const result = await s.update(forceFallback);

    expect(result).toMatchObject({ from: s.reviewed.head, fastForward: true });
    expect(result.changed).toContain("+++ b/f1.txt");
    expect(result.changed).not.toContain("app.txt");
  });

  test("merging main into the PR changed nothing the author wrote", async () => {
    const s = await setup();
    await pushMain(s.forge, "f3.txt", "upstream\n");
    await gitText(s.author, ["pull", "-q", "--no-rebase", "--no-edit", "origin", "main"]);

    const result = await s.update(forceFallback);

    expect(result.fastForward).toBe(false);
    expect(result.changed).toBe("");
  });

  test("a rebase, squash and one-line tweak shows only the tweak", async () => {
    const s = await setup();
    write(s.author, "app.txt", lines(10, { 7: "line 7 pr", 2: "line 2 pr" }));
    await commitAll(s.author, "pr: line 2");
    await pushMain(s.forge, "f2.txt", "upstream\n");
    await gitText(s.author, ["fetch", "-q", "origin"]);
    // Squashed onto the new main: the same edits plus the tweak.
    await gitText(s.author, ["reset", "-q", "--hard", "origin/main"]);
    write(s.author, "app.txt", lines(10, { 7: "line 7 pr-v2", 2: "line 2 pr" }));
    await commitAll(s.author, "pr, squashed and tweaked");

    const result = await s.update(forceFallback);

    expect(result.fastForward).toBe(false);
    expect(result.changed).toContain("-line 2\n+line 2 pr");
    expect(result.changed).toContain("-line 7 pr\n+line 7 pr-v2");
    expect(result.changed).not.toContain("f2.txt");
  });

  test("a rebase over a conflicting change asks for a full summary", async () => {
    const s = await setup();
    await pushMain(s.forge, "app.txt", lines(10, { 7: "line 7 main" }));
    await gitText(s.author, ["fetch", "-q", "origin"]);
    await gitText(s.author, ["reset", "-q", "--hard", "origin/main"]);
    write(s.author, "app.txt", lines(10, { 7: "line 7 pr, again" }));
    await commitAll(s.author, "pr, redone");

    const result = await s.update(forceFallback);

    expect(result).toMatchObject({
      from: null,
      reason: "the pull request was rebased over conflicting changes",
    });
  });
});

test("markReviewed records the reviewed head and merge base", async () => {
  const s = await setup();

  expect(await resolveCommit(s.user, reviewRef("7", "reviewed"))).toBe(s.reviewed.head);
  expect(await resolveCommit(s.user, reviewRef("7", "reviewed-base"))).toBe(s.reviewed.mergeBase);
});
