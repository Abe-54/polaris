import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { FAKE_GHE_CLIENT_ID } from "../../../scripts/lib/githubFake/index.ts";
import type { PullRef } from "../../shared/github.ts";
import { GHE_HOST, harness, signIn } from "./github.testing.ts";
import { GitHub, type MergeInput } from "./index.ts";

const harnesses: Array<ReturnType<typeof harness>> = [];

const open = () => {
  const h = harness();

  harnesses.push(h);

  return h;
};

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

const REPO = "acme/widgets";

const PR42: PullRef = { repo: { owner: "acme", name: "widgets" }, number: 42 };

const PR43: PullRef = { repo: { owner: "acme", name: "widgets" }, number: 43 };

const PR44: PullRef = { repo: { owner: "acme", name: "widgets" }, number: 44 };

const HEAD44 = "abcdef0123456789abcdef0123456789abcdef01";

const as = <A, E>(
  h: ReturnType<typeof harness>,
  login: string,
  body: Effect.Effect<A, E, GitHub>
) => h.run(Effect.andThen(signIn(h, login), body));

const actions = (pull: PullRef) => GitHub.use((gh) => gh.pullActions(pull));

const failure = async <A, E>(promise: Promise<Exit.Exit<A, E>>) => {
  const exit = await promise;

  return Exit.isFailure(exit) ? JSON.stringify(exit.cause) : "succeeded";
};

const merge44 = (patch: Partial<MergeInput> = {}): MergeInput => ({
  pull: PR44,
  pullId: "PR_kwDOacme44",
  method: "squash",
  title: "Bump the parser to 4.2 (#44)",
  body: "* Bump the parser",
  expectedHeadOid: HEAD44,
  deleteBranch: true,
  ...patch,
});

const pullOf = (h: ReturnType<typeof harness>, number: number) => {
  const found = h.fake.world.pulls.find((p) => p.repo === REPO && p.number === number);

  if (found === undefined) throw new Error(`no #${number}`);

  return found;
};

describe("reviewers", () => {
  test("who is asked and who reviewed; asking a user and a team, then taking one back", async () => {
    const h = open();

    const seen = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;
        const before = (yield* actions(PR42)).reviewers;

        yield* gh.requestReviewers({ pull: PR42, users: ["hubot"], teams: ["platform"] });
        const added = (yield* actions(PR42)).reviewers;

        yield* gh.removeReviewers({ pull: PR42, users: ["hubot"], teams: [] });
        const removed = (yield* actions(PR42)).reviewers;

        return { before, added, removed };
      })
    );

    expect(seen.before).toMatchObject({
      requested: [{ kind: "user", login: "mona", name: "Mona Lisa" }],
      reviewed: [],
      canRequest: true,
      author: "octocat",
    });
    expect(seen.before.suggested).toEqual([]);
    expect(seen.added.requested.map((r) => `${r.kind}:${r.login}`)).toEqual([
      "user:mona",
      "user:hubot",
      "team:platform",
    ]);
    expect(seen.removed.requested.map((r) => r.login)).toEqual(["mona", "platform"]);
  });

  test("a submitted review shows with its state", async () => {
    const h = open();

    const reviewers = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;

        yield* gh.detail(PR42);
        yield* gh.submitReview({ pull: PR42, pullId: "PR_kwDOacme42", event: "approve", body: "" });

        return (yield* actions(PR42)).reviewers;
      })
    );

    expect(reviewers.reviewed).toMatchObject([{ login: "mona", state: "approved" }]);
    expect(reviewers.requested).toEqual([]);
  });

  test("search finds collaborators and the organization's teams", async () => {
    const h = open();

    const found = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;

        return {
          hu: yield* gh.searchReviewers(PR42, "hu"),
          plat: yield* gh.searchReviewers(PR42, "plat"),
        };
      })
    );

    expect(found.hu).toEqual([{ kind: "user", login: "hubot", name: "Hubot" }]);
    expect(found.plat).toEqual([{ kind: "team", login: "platform", name: "Platform" }]);
  });

  test("GitHub's refusals come back in its words: the author, and read-only access", async () => {
    const h = open();

    const author = await failure(
      as(
        h,
        "mona",
        Effect.exit(
          GitHub.use((gh) => gh.requestReviewers({ pull: PR42, users: ["octocat"], teams: [] }))
        )
      )
    );

    expect(author).toContain("Review cannot be requested from pull request author.");

    const h2 = open();

    const readOnly = await as(
      h2,
      "hubot",
      Effect.gen(function* () {
        const view = yield* actions(PR42);

        const exit = yield* Effect.exit(
          GitHub.use((gh) => gh.requestReviewers({ pull: PR42, users: ["mona"], teams: [] }))
        );

        return { canRequest: view.reviewers.canRequest, exit: JSON.stringify(exit) };
      })
    );

    expect(readOnly.canRequest).toBe(false);
    expect(readOnly.exit).toContain("GitHubForbidden");
  });

  test("on a GitHub Enterprise host, through its own API paths", async () => {
    const h = open();

    const reviewers = await h.run(
      Effect.gen(function* () {
        const gh = yield* GitHub;

        yield* gh.addHost({ host: GHE_HOST, clientId: FAKE_GHE_CLIENT_ID });
        yield* signIn(h, "mona-ent", GHE_HOST);

        const pull: PullRef = {
          repo: { host: GHE_HOST, owner: "platform", name: "api" },
          number: 12,
        };

        return (yield* gh.pullActions(pull)).reviewers;
      })
    );

    expect(reviewers.requested.map((r) => r.login)).toEqual(["mona-ent"]);
    expect(h.ghe.requests.some((r) => r.name === "PullActions" && r.status === 200)).toBe(true);
  });
});

describe("merging: what blocks it", () => {
  test("an open, clean pull request merges; the account may merge; GitHub's methods", async () => {
    const h = open();
    const merge = (await as(h, "mona", actions(PR44))).merge;

    expect(merge).toMatchObject({
      state: "open",
      blocks: [],
      viewerCanMerge: true,
      methods: ["merge", "squash", "rebase"],
      defaultMethod: "merge",
      autoMerge: { available: false, enabled: null },
      branch: { name: "deps/parser-4.2", keep: null },
      messages: { squash: { title: "Bump the parser to 4.2 (#44)" } },
    });
  });

  test("draft, conflicts, required approval, failing and running checks", async () => {
    const h = open();

    h.fake.protectBranch(REPO, "main", { requiredApprovals: 1, requiredChecks: true });

    const views = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const draft = (yield* actions(PR43)).merge.blocks;

        h.fake.setChecks(REPO, 42, { failing: 4, passing: 2 });
        const failing = (yield* actions(PR42)).merge.blocks;

        h.fake.setChecks(REPO, 42, { pending: 3 });
        const running = (yield* actions(PR42)).merge.blocks;

        h.fake.setConflicting(REPO, 42, true);
        const conflicts = (yield* actions(PR42)).merge.blocks;

        return { draft, failing, running, conflicts };
      })
    );

    expect(views.draft).toEqual([{ kind: "draft" }]);
    expect(views.failing).toEqual([
      { kind: "approval-required" },
      { kind: "checks-failing", count: 4 },
    ]);
    expect(views.running).toEqual([
      { kind: "approval-required" },
      { kind: "checks-pending", count: 3 },
    ]);
    expect(views.conflicts).toEqual([{ kind: "conflicts" }]);
  });

  test("failing checks that aren't required warn but don't block", async () => {
    const h = open();

    h.fake.setChecks(REPO, 44, { failing: 1, passing: 3 });
    const merge = (await as(h, "mona", actions(PR44))).merge;

    expect(merge.blocks).toEqual([]);
    expect(merge.checks).toEqual({ total: 4, failing: 1, pending: 0 });
  });

  test("an approval clears the required review", async () => {
    const h = open();

    h.fake.protectBranch(REPO, "main", { requiredApprovals: 1 });

    const blocks = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;

        yield* gh.detail(PR42);
        yield* gh.submitReview({ pull: PR42, pullId: "PR_kwDOacme42", event: "approve", body: "" });

        return (yield* actions(PR42)).merge.blocks;
      })
    );

    expect(blocks).toEqual([]);
  });

  test("read access can't merge", async () => {
    const h = open();
    const merge = (await as(h, "hubot", actions(PR44))).merge;

    expect(merge.viewerCanMerge).toBe(false);
  });
});

describe("merging: methods", () => {
  test("only what the repository allows, its default first choice", async () => {
    const h = open();

    h.fake.setRepo(REPO, { mergeCommitAllowed: false, defaultMethod: "REBASE" });
    const merge = (await as(h, "mona", actions(PR44))).merge;

    expect(merge.methods).toEqual(["squash", "rebase"]);
    expect(merge.defaultMethod).toBe("rebase");
  });

  test("a method the repository refuses is refused before asking", async () => {
    const h = open();

    h.fake.setRepo(REPO, { squashMergeAllowed: false });

    const exit = await failure(as(h, "mona", Effect.exit(GitHub.use((gh) => gh.merge(merge44())))));

    expect(exit).toContain("doesn't allow squash merges");
    expect(pullOf(h, 44).state).toBe("OPEN");
  });

  test("squash with the edited message; rebase sends none", async () => {
    const h = open();

    const result = await as(
      h,
      "mona",
      GitHub.use((gh) =>
        gh.merge(merge44({ title: "Parser 4.2", body: "Faster.", deleteBranch: false }))
      )
    );

    expect(result).toMatchObject({ method: "squash", branch: { kind: "kept", reason: "asked" } });
    expect(pullOf(h, 44)).toMatchObject({
      state: "MERGED",
      mergedWith: { method: "SQUASH", title: "Parser 4.2", body: "Faster.", by: "mona" },
    });

    const h2 = open();

    await as(
      h2,
      "mona",
      GitHub.use((gh) => gh.merge(merge44({ method: "rebase" })))
    );
    expect(pullOf(h2, 44).mergedWith).toMatchObject({ method: "REBASE", title: null, body: null });
  });

  test("new commits since the user looked stop the merge", async () => {
    const h = open();

    h.fake.push(REPO, 44);

    const exit = await failure(as(h, "mona", Effect.exit(GitHub.use((gh) => gh.merge(merge44())))));

    expect(exit).toContain("New commits arrived");
    expect(pullOf(h, 44).state).toBe("OPEN");
  });

  test("a blocked pull request is refused by GitHub", async () => {
    const h = open();

    h.fake.setConflicting(REPO, 44, true);

    const exit = await failure(as(h, "mona", Effect.exit(GitHub.use((gh) => gh.merge(merge44())))));

    expect(exit).toContain("not mergeable");
  });
});

describe("merging: the head branch afterwards", () => {
  const branchOf = async (h: ReturnType<typeof harness>, patch: Partial<MergeInput> = {}) =>
    (
      await as(
        h,
        "mona",
        GitHub.use((gh) => gh.merge(merge44(patch)))
      )
    ).branch;

  test("deleted when asked, and restored", async () => {
    const h = open();

    const branch = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;
        const merged = yield* gh.merge(merge44());
        const gone = (yield* actions(PR44)).merge.branch.keep;

        yield* gh.restoreBranch({ repo: REPO, name: "deps/parser-4.2", sha: HEAD44 });

        return { outcome: merged.branch, gone, back: (yield* actions(PR44)).merge.branch.keep };
      })
    );

    expect(branch.outcome).toEqual({
      kind: "deleted",
      name: "deps/parser-4.2",
      sha: HEAD44,
      repo: REPO,
      byGitHub: false,
    });
    expect(branch.gone).toBe("gone");
    expect(branch.back).toBe(null);
  });

  test.each<["default" | "protected" | "fork", (h: ReturnType<typeof open>) => void]>([
    ["default", (h) => h.fake.setRepo(REPO, { defaultBranch: "deps/parser-4.2" })],
    ["protected", (h) => h.fake.protectBranch(REPO, "deps/parser-4.2")],
    ["fork", (h) => void (pullOf(h, 44).isCrossRepository = true)],
  ])("kept: the %s branch", async (reason, arrange) => {
    const h = open();

    arrange(h);
    expect(await branchOf(h)).toEqual({ kind: "kept", name: "deps/parser-4.2", reason });
  });

  test("GitHub deletes it itself when the repository says so", async () => {
    const h = open();

    h.fake.setRepo(REPO, { deleteBranchOnMerge: true });
    expect(await branchOf(h, { deleteBranch: false })).toMatchObject({
      kind: "deleted",
      byGitHub: true,
    });
  });
});

describe("auto-merge", () => {
  test("offered while checks run; enabling it records the method and who asked", async () => {
    const h = open();

    h.fake.setRepo(REPO, { autoMergeAllowed: true });
    h.fake.protectBranch(REPO, "main", { requiredChecks: true });
    h.fake.setChecks(REPO, 44, { pending: 2 });

    const seen = await as(
      h,
      "mona",
      Effect.gen(function* () {
        const gh = yield* GitHub;
        const before = (yield* actions(PR44)).merge;
        const { deleteBranch: _, ...input } = merge44();

        yield* gh.autoMerge({ ...input, enable: true });

        return { before, after: (yield* actions(PR44)).merge };
      })
    );

    expect(seen.before.blocks).toEqual([{ kind: "checks-pending", count: 2 }]);
    expect(seen.before.autoMerge.available).toBe(true);
    expect(seen.after.autoMerge).toEqual({
      available: false,
      enabled: { method: "squash", by: "mona" },
    });
  });
});
