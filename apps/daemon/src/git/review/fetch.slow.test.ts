import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewCheckoutBlocker } from "@polaris/protocol";
import { Predicate } from "effect";
import { CheckoutBlocked } from "../../services.ts";
import { gitText, resolveCommit } from "../git.ts";
import { commitAll, removeTempDir, tempDir, write } from "../testing.ts";
import { describeFetchFailure, fetchPullRequest, type PullRequestFetch } from "./fetch.ts";
import { reviewRef } from "./refs.ts";
import { parseRemoteUrl, pickFetchSource } from "./remotes.ts";
import {
  BASE_REPO,
  contributor,
  createForge,
  FORK_URL,
  publishPullRequest,
  pushMain,
  pushMainCommits,
  userClone,
} from "./testing.ts";

// Each test runs tens of real gits: past bun's 5 s default on a loaded runner (as commit.slow.test.ts).
setDefaultTimeout(15_000);

/** The deepening test runs about 41 s on a Windows desktop, where every git spawn is slow. */
const DEEPEN_MS = process.platform === "win32" ? 120_000 : 30_000;

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const setup = async () => {
  const forge = await createForge();
  cleanup.push(forge.root);
  const author = await contributor(forge, forge.mainCommits[1] ?? "main");
  write(author, "feature.txt", "feature\n");
  await commitAll(author, "feature");
  const head = await publishPullRequest(forge, author, 7);

  return { forge, author, head };
};

const pr = (repoPath: string, overrides: Partial<PullRequestFetch> = {}): PullRequestFetch => ({
  repoPath,
  key: "7",
  repo: BASE_REPO,
  number: 7,
  baseRef: "main",
  baseCommit: "",
  unshallow: false,
  trusted: false,
  ...overrides,
});

const blockerOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CheckoutBlocked) return error.blocker;
    throw error;
  }

  throw new Error("expected the fetch to be blocked");
};

const userState = async (repo: string) => ({
  originMain: await resolveCommit(repo, "refs/remotes/origin/main"),
  head: await gitText(repo, ["rev-parse", "HEAD"]),
  branches: await gitText(repo, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]),
  fetchHead: existsSync(join(repo, ".git", "FETCH_HEAD")),
});

describe("parseRemoteUrl", () => {
  test("reads scp-style, ssh:// and https URLs", () => {
    expect(parseRemoteUrl("git@github.com:Acme/App.git")).toEqual({
      transport: "ssh",
      host: "github.com",
      owner: "Acme",
      name: "App",
    });
    expect(parseRemoteUrl("ssh://git@GHE.example.com:2222/acme/app")).toMatchObject({
      transport: "ssh",
      host: "ghe.example.com",
      owner: "acme",
    });
    expect(parseRemoteUrl("https://user@github.com/acme/app.git/")).toMatchObject({
      transport: "https",
      name: "app",
    });
    expect(parseRemoteUrl("/srv/git/app.git")).toBeNull();
  });
});

describe("fetchPullRequest", () => {
  test("fetches the head and base into review refs and moves none of the user's refs", async () => {
    const { forge, head } = await setup();
    const user = await userClone(forge);
    cleanup.push(user);
    // main moves on the code host after the user's last fetch: origin/main must stay behind.
    const newMain = await pushMain(forge, "later.txt", "later\n");
    const before = await userState(user);

    const fetched = await fetchPullRequest(pr(user));

    expect(fetched).toEqual({ head, mergeBase: forge.mainCommits[1] ?? "" });
    expect(await resolveCommit(user, reviewRef("7", "head"))).toBe(head);
    expect(await resolveCommit(user, reviewRef("7", "base"))).toBe(newMain);
    expect(await userState(user)).toEqual(before);
    expect(before.originMain).not.toBe(newMain);
  });

  test("a stacked layer's merge base is its base branch (the layer below), not the trunk", async () => {
    const forge = await createForge();
    cleanup.push(forge.root);
    const author = await contributor(forge, "main");
    write(author, "layer-1.txt", "one\n");
    const layer1 = await commitAll(author, "layer 1");
    await gitText(author, ["push", "-q", forge.base, "HEAD:refs/heads/stack/one"]);
    write(author, "layer-2.txt", "two\n");
    await commitAll(author, "layer 2");
    const head = await publishPullRequest(forge, author, 8);
    const user = await userClone(forge);
    cleanup.push(user);

    const fetched = await fetchPullRequest(pr(user, { key: "8", number: 8, baseRef: "stack/one" }));

    // Layer 2 is reviewed against layer 1's head, as GitHub's diff is: only its own commit.
    expect(fetched).toEqual({ head, mergeBase: layer1 });
    expect(await gitText(user, ["rev-list", "--count", `${fetched.mergeBase}..${head}`])).toBe("1");
  });

  test("a fork's pull request comes from the base repository, not the user's fork remote", async () => {
    const forge = await createForge();
    cleanup.push(forge.root);
    const author = await contributor(forge, "main");
    write(author, "fork.txt", "from a fork\n");
    await commitAll(author, "fork change");
    const head = await publishPullRequest(forge, author, 7, { viaFork: true });
    // origin is the user's fork; upstream is the base repository.
    const user = await userClone(forge, { remoteUrl: FORK_URL });
    cleanup.push(user);
    await gitText(user, ["remote", "add", "upstream", "git@github.com:acme/app.git"]);
    await gitText(user, ["config", `url.${forge.base}.insteadOf`, "git@github.com:acme/app.git"]);

    expect(await pickFetchSource(user, BASE_REPO)).toEqual({
      source: "upstream",
      transport: "ssh",
    });
    expect((await fetchPullRequest(pr(user))).head).toBe(head);
  });

  test("without a matching remote it fetches the repository by URL, adding no remote", async () => {
    const { forge, head } = await setup();
    const user = await userClone(forge, { remoteUrl: FORK_URL });
    cleanup.push(user);
    const remotes = await gitText(user, ["config", "--get-regexp", "^remote\\."]);

    expect(await pickFetchSource(user, BASE_REPO)).toEqual({
      source: "https://github.com/acme/app.git",
      transport: "https",
    });
    expect((await fetchPullRequest(pr(user))).head).toBe(head);
    expect(await gitText(user, ["config", "--get-regexp", "^remote\\."])).toBe(remotes);
  });

  test("a force-pushed head replaces the fetched one", async () => {
    const { forge, author, head } = await setup();
    const user = await userClone(forge);
    cleanup.push(user);
    await fetchPullRequest(pr(user));

    await gitText(author, ["reset", "-q", "--hard", "HEAD~1"]);
    write(author, "feature.txt", "rewritten\n");
    const rewritten = await commitAll(author, "feature, rewritten");
    await publishPullRequest(forge, author, 7);

    const fetched = await fetchPullRequest(pr(user));

    expect(fetched.head).toBe(rewritten);
    expect(rewritten).not.toBe(head);
  });

  test("a missing pull request is a FetchFailed the user can read", async () => {
    const { forge } = await setup();
    const user = await userClone(forge);
    cleanup.push(user);

    const blocker = await blockerOf(fetchPullRequest(pr(user, { number: 99, key: "99" })));

    expect(blocker).toEqual(
      ReviewCheckoutBlocker.cases.FetchFailed.make({
        message: "pull request #99 was not found on acme/app",
      })
    );
  });

  /** A fake ssh that logs its arguments to `<bin>/<name>.args` and fails authentication. */
  const fakeSsh = (bin: string, name: string) => {
    // Forward slashes: Git for Windows reads config values and runs commands through sh.
    const log = join(bin, `${name}.args`).replaceAll("\\", "/");
    write(
      bin,
      name,
      `#!/bin/sh\necho "$@" > ${log}\necho "git@github.com: Permission denied (publickey)." >&2\nexit 255\n`
    );
    chmodSync(join(bin, name), 0o755);

    return { command: join(bin, name).replaceAll("\\", "/"), log };
  };

  /** A clone with an ssh remote whose own config names an ssh command; the Host's names another. */
  const sshSetup = async () => {
    const { forge } = await setup();
    const user = await userClone(forge, { remoteUrl: "git@github.com:acme/app.git" });
    const bin = tempDir("polaris-ssh-");
    cleanup.push(user, bin);
    await gitText(user, ["config", "--unset-all", `url.${forge.base}.insteadOf`]);
    const own = fakeSsh(bin, "repo-ssh");
    const host = fakeSsh(bin, "host-ssh");
    await gitText(user, ["config", "core.sshCommand", `${own.command} -o UserOwnOption=yes`]);
    write(bin, "gitconfig", `[core]\n\tsshCommand = ${host.command} -o HostOption=yes\n`);

    return { user, own, host, hostConfig: join(bin, "gitconfig") };
  };

  const withHostConfig = async <A>(path: string, f: () => Promise<A>) => {
    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = path;

    try {
      return await f();
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }
  };

  test("in a trusted Workspace, ssh runs the repository's own ssh command with BatchMode, and fails without prompting", async () => {
    const s = await sshSetup();

    const blocker = await withHostConfig(s.hostConfig, () =>
      blockerOf(fetchPullRequest(pr(s.user, { trusted: true })))
    );

    expect(readFileSync(s.own.log, "utf8")).toContain("-o UserOwnOption=yes -o BatchMode=yes");
    expect(existsSync(s.host.log)).toBe(false);
    expect(Predicate.isTagged(blocker, "FetchFailed") ? blocker.message : "").toStartWith(
      "ssh could not authenticate on this Host"
    );
  });

  test("in an untrusted Workspace, ssh runs the Host's ssh command, never the repository's", async () => {
    const s = await sshSetup();

    await withHostConfig(s.hostConfig, () => blockerOf(fetchPullRequest(pr(s.user))));

    expect(readFileSync(s.host.log, "utf8")).toContain("-o HostOption=yes -o BatchMode=yes");
    expect(existsSync(s.own.log)).toBe(false);
  });

  test("a shallow clone fetches the code host's base commit when it is the merge base", async () => {
    const { forge, head } = await setup();
    await pushMain(forge, "later.txt", "later\n");
    const user = await userClone(forge, { depth: 1 });
    cleanup.push(user);
    const noDeepening = { deepenSteps: [] };

    expect(await blockerOf(fetchPullRequest(pr(user, noDeepening)))).toEqual(
      ReviewCheckoutBlocker.cases.ShallowClone.make({})
    );

    const mergeBase = forge.mainCommits[1] ?? "";
    const fetched = await fetchPullRequest(pr(user, { ...noDeepening, baseCommit: mergeBase }));

    expect(fetched).toEqual({ head, mergeBase });
    expect(await gitText(user, ["rev-parse", "--is-shallow-repository"])).toBe("true");
  });

  // The Desktop sends GitHub's baseRefOid: the base branch's tip, not the merge base (Q-check B2).
  test(
    "a shallow clone opened with the base branch's tip deepens to the merge base and stays shallow",
    async () => {
      const forge = await createForge();
      cleanup.push(forge.root);

      const branchPoint = await pushMainCommits(forge, "old", 40);
      const author = await contributor(forge, branchPoint);
      write(author, "feature.txt", "feature\n");
      await commitAll(author, "feature");
      const head = await publishPullRequest(forge, author, 7);

      const tip = await pushMainCommits(forge, "new", 15);
      const user = await userClone(forge, { depth: 1 });
      cleanup.push(user);

      const fetched = await fetchPullRequest(pr(user, { baseCommit: tip }));

      expect(fetched).toEqual({ head, mergeBase: branchPoint });
      expect(await gitText(user, ["rev-parse", "--is-shallow-repository"])).toBe("true");
      expect(Number(await gitText(user, ["rev-list", "--count", "main"]))).toBeLessThan(
        forge.mainCommits.length
      );
    },
    DEEPEN_MS
  );

  test("past the deepening budget it is a shallow clone, for the user to decide", async () => {
    const { forge } = await setup();

    const tip = await pushMainCommits(forge, "later", 6);
    const user = await userClone(forge, { depth: 1 });
    cleanup.push(user);

    expect(
      await blockerOf(fetchPullRequest(pr(user, { baseCommit: tip, deepenSteps: [1, 2] })))
    ).toEqual(ReviewCheckoutBlocker.cases.ShallowClone.make({}));
    expect(await gitText(user, ["rev-parse", "--is-shallow-repository"])).toBe("true");
  }, 30_000);

  test("unshallow fetches full history, only when asked", async () => {
    const { forge, head } = await setup();
    const user = await userClone(forge, { depth: 1 });
    cleanup.push(user);

    const fetched = await fetchPullRequest(pr(user, { unshallow: true }));

    expect(fetched).toEqual({ head, mergeBase: forge.mainCommits[1] ?? "" });
    expect(await gitText(user, ["rev-parse", "--is-shallow-repository"])).toBe("false");
  });
});

describe("describeFetchFailure", () => {
  const options = { number: 7, repo: BASE_REPO, timeoutMs: 600_000 };

  test("names a missing SSH agent", () => {
    const saved = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;

    try {
      expect(
        describeFetchFailure(
          { code: 128, stdout: new Uint8Array(), stderr: "Permission denied (publickey)." },
          "ssh",
          options
        )
      ).toBe(
        "ssh could not authenticate on this Host (the Daemon has no SSH agent: SSH_AUTH_SOCK is not set): Permission denied (publickey)."
      );
    } finally {
      if (saved !== undefined) process.env.SSH_AUTH_SOCK = saved;
    }
  });

  test("a killed fetch timed out", () => {
    expect(
      describeFetchFailure({ code: 137, stdout: new Uint8Array(), stderr: "" }, "https", options)
    ).toBe("the fetch timed out after 600 s");
  });

  test("anything else carries git's stderr", () => {
    expect(
      describeFetchFailure(
        { code: 128, stdout: new Uint8Array(), stderr: "fatal: terminal prompts disabled\n" },
        "https",
        options
      )
    ).toBe("git fetch failed: fatal: terminal prompts disabled");
  });
});
