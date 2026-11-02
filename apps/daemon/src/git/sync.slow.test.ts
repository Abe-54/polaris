import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GitSyncAction, GitSyncItem } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { posixTest } from "../platform/testing.ts";
import { handleGitStatus, handleGitSync } from "./GitRpcs.ts";
import { gitText } from "./git.ts";
import { commitAll, makeRepo, removeDir, tempDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };

// The Host's own global config (credential helpers, hooks, pull.rebase) must not leak in.
let home = "";

beforeAll(() => {
  home = tempDir("polaris-sync-home-");
  writeFileSync(join(home, "gitconfig"), "");
  process.env.GIT_CONFIG_GLOBAL = join(home, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;

  if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.system;

  removeDir(home);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const identity = async (root: string) => {
  await gitText(root, ["config", "user.name", "Other"]);
  await gitText(root, ["config", "user.email", "other@example.com"]);
  await gitText(root, ["config", "commit.gpgsign", "false"]);
};

/** A clone with `main` pushed to a bare `origin`, and a second clone of it ("someone else"). */
const setup = async () => {
  const bare = tempDir("polaris-bare-");
  cleanup.push(bare);
  await gitText(bare, ["init", "-q", "--bare", "-b", "main"]);
  const mine = await makeRepo({ "a.txt": "one\ntwo\nthree\n" });
  cleanup.push(mine);
  await gitText(mine, ["remote", "add", "origin", bare]);
  await gitText(mine, ["push", "-q", "-u", "origin", "main"]);
  const theirsParent = tempDir("polaris-theirs-");
  cleanup.push(theirsParent);
  const theirs = join(theirsParent, "clone");
  await gitText(theirsParent, ["clone", "-q", bare, theirs]);
  await identity(theirs);

  return { bare, mine, theirs };
};

/** Someone else pushes a commit to origin/main. */
const theyPush = async (theirs: string, file: string, content: string) => {
  write(theirs, file, content);
  await commitAll(theirs, `their ${file}`);
  await gitText(theirs, ["push", "-q", "origin", "main"]);
};

const sync = (cwd: string, action: GitSyncAction) =>
  Effect.runPromise(Stream.runCollect(handleGitSync({ cwd, action }))).then(
    (items): ReadonlyArray<GitSyncItem> => [...items]
  );

const status = (cwd: string) => Effect.runPromise(handleGitStatus({ cwd }));

const ended = (items: ReadonlyArray<GitSyncItem>) => {
  const last = items.at(-1);

  if (last === undefined) return "nothing";

  return GitSyncItem.guards.Failed(last) ? last.reason : last._tag;
};

const counts = async (cwd: string) => {
  const s = await status(cwd);

  return { ahead: s.ahead, behind: s.behind, upstream: s.tracking?.upstream ?? null };
};

describe("git.status tracking", () => {
  test("ahead and behind come from local refs: a fetch shows behind, a commit shows ahead", async () => {
    const { mine, theirs } = await setup();
    await theyPush(theirs, "b.txt", "b\n");

    expect(await counts(mine)).toEqual({ ahead: 0, behind: 0, upstream: "origin/main" });

    expect(ended(await sync(mine, "fetch"))).toBe("Done");
    expect(await counts(mine)).toEqual({ ahead: 0, behind: 1, upstream: "origin/main" });

    write(mine, "c.txt", "c\n");
    await commitAll(mine, "mine");
    expect(await counts(mine)).toEqual({ ahead: 1, behind: 1, upstream: "origin/main" });
  });

  test("a branch without an upstream names the remote Publish would push to; no remote names none", async () => {
    const { mine } = await setup();
    await gitText(mine, ["switch", "-q", "-c", "feature"]);
    expect((await status(mine)).tracking).toEqual({
      upstream: null,
      gone: false,
      remote: "origin",
    });

    const lonely = await makeRepo();
    cleanup.push(lonely);
    expect((await status(lonely)).tracking).toEqual({ upstream: null, gone: false, remote: null });
  });

  test("an upstream whose branch was deleted on the remote is gone", async () => {
    const { mine, bare } = await setup();
    await gitText(mine, ["switch", "-q", "-c", "feature"]);
    expect(ended(await sync(mine, "publish"))).toBe("Done");
    await gitText(bare, ["branch", "-q", "-D", "feature"]);
    await gitText(mine, ["fetch", "-q", "--prune", "origin"]);

    expect((await status(mine)).tracking).toEqual({
      upstream: "origin/feature",
      gone: true,
      remote: "origin",
    });
  });
});

describe("git.sync", () => {
  test("pull fast-forwards a branch that is only behind", async () => {
    const { mine, theirs } = await setup();
    await theyPush(theirs, "b.txt", "b\n");

    const items = await sync(mine, "pull");

    expect(items.filter(GitSyncItem.guards.Step)).toEqual([
      GitSyncItem.cases.Step.make({ step: "pull", remote: "origin" }),
    ]);
    expect(ended(items)).toBe("Done");
    expect(await gitText(mine, ["rev-parse", "HEAD"])).toBe(
      await gitText(theirs, ["rev-parse", "HEAD"])
    );
  });

  test("push sends what's ahead to the upstream", async () => {
    const { mine, bare } = await setup();
    write(mine, "c.txt", "c\n");
    const head = await commitAll(mine, "mine");

    expect(ended(await sync(mine, "push"))).toBe("Done");
    expect(await gitText(bare, ["rev-parse", "main"])).toBe(head);
    expect(await counts(mine)).toEqual({ ahead: 0, behind: 0, upstream: "origin/main" });
  });

  test("publish pushes a new branch with -u, so it then has an upstream", async () => {
    const { mine, bare } = await setup();
    await gitText(mine, ["switch", "-q", "-c", "lucas/eng-169-research-herdr-dagrs-dag-model"]);
    write(mine, "c.txt", "c\n");
    const head = await commitAll(mine, "mine");

    expect(ended(await sync(mine, "publish"))).toBe("Done");
    expect(await gitText(bare, ["rev-parse", "lucas/eng-169-research-herdr-dagrs-dag-model"])).toBe(
      head
    );
    expect((await counts(mine)).upstream).toBe(
      "origin/lucas/eng-169-research-herdr-dagrs-dag-model"
    );
  });

  test("diverged with no pull config: --ff-only refuses, and no merge commit is made", async () => {
    const { mine, theirs } = await setup();
    await theyPush(theirs, "b.txt", "b\n");
    write(mine, "c.txt", "c\n");
    const head = await commitAll(mine, "mine");

    expect(ended(await sync(mine, "sync"))).toBe("diverged");
    expect(await gitText(mine, ["rev-parse", "HEAD"])).toBe(head);
  });

  test("diverged with pull.rebase set: sync rebases onto the upstream, then pushes", async () => {
    const { mine, theirs, bare } = await setup();
    await theyPush(theirs, "b.txt", "b\n");
    write(mine, "c.txt", "c\n");
    await commitAll(mine, "mine");
    await gitText(mine, ["config", "pull.rebase", "true"]);

    const items = await sync(mine, "sync");

    expect(items.filter(GitSyncItem.guards.Step).map((s) => s.step)).toEqual(["pull", "push"]);
    expect(ended(items)).toBe("Done");
    expect(await gitText(bare, ["rev-list", "--count", "--merges", "main"])).toBe("0");
    expect(await counts(mine)).toEqual({ ahead: 0, behind: 0, upstream: "origin/main" });
  });

  test("a push the remote rejects as not a fast-forward says rejected, and moves nothing", async () => {
    const { mine, theirs, bare } = await setup();
    await theyPush(theirs, "b.txt", "b\n");
    const remoteHead = await gitText(bare, ["rev-parse", "main"]);
    write(mine, "c.txt", "c\n");
    await commitAll(mine, "mine");

    expect(ended(await sync(mine, "push"))).toBe("rejected");
    expect(await gitText(bare, ["rev-parse", "main"])).toBe(remoteHead);
  });

  test("a merge pull that conflicts stops on conflicts", async () => {
    const { mine, theirs } = await setup();
    await theyPush(theirs, "a.txt", "one\nTHEIRS\nthree\n");
    write(mine, "a.txt", "one\nMINE\nthree\n");
    await commitAll(mine, "mine");
    await gitText(mine, ["config", "pull.rebase", "false"]);

    expect(ended(await sync(mine, "pull"))).toBe("conflicts");
    expect(await gitText(mine, ["status", "--porcelain"])).toBe("UU a.txt");
  });

  test("a pull that would overwrite uncommitted edits says so and leaves them", async () => {
    const { mine, theirs } = await setup();
    await theyPush(theirs, "a.txt", "one\nTHEIRS\nthree\n");
    write(mine, "a.txt", "one\nMINE\nthree\n");

    expect(ended(await sync(mine, "pull"))).toBe("local-changes");
    expect(readFileSync(join(mine, "a.txt"), "utf8")).toBe("one\nMINE\nthree\n");
  });

  test.each([
    ["detached", "pull", "detached"],
    ["no upstream", "push", "no-upstream"],
    ["no remote", "fetch", "no-remote"],
  ] as const)("%s: %s refuses before running git", async (situation, action, reason) => {
    const { mine } = await setup();

    if (situation === "detached") await gitText(mine, ["switch", "-q", "--detach"]);

    if (situation === "no upstream") await gitText(mine, ["switch", "-q", "-c", "feature"]);

    if (situation === "no remote") await gitText(mine, ["remote", "remove", "origin"]);

    const items = await sync(mine, action);

    expect(items.filter(GitSyncItem.guards.Step)).toEqual([]);
    expect(ended(items)).toBe(reason);
  });
});

describe("git.sync never prompts", () => {
  const fakeSsh = (script: string) => {
    const bin = tempDir("polaris-ssh-");
    cleanup.push(bin);
    // Forward slashes: Git for Windows reads config values and runs commands through sh.
    const path = join(bin, "fake-ssh").replaceAll("\\", "/");
    const args = join(bin, "args").replaceAll("\\", "/");
    writeFileSync(path, `#!/bin/sh\necho "$@" > ${args}\n${script}\n`);
    chmodSync(path, 0o755);

    return { path, args };
  };

  test.each([
    ["auth", 'echo "git@example.com: Permission denied (publickey)." >&2; exit 255'],
    ["network", 'echo "ssh: Could not resolve hostname example.invalid" >&2; exit 255'],
  ])("an ssh remote that fails with %s says so, with BatchMode on", async (reason, script) => {
    const { mine } = await setup();
    const ssh = fakeSsh(script);
    await gitText(mine, ["remote", "set-url", "origin", "git@example.invalid:acme/app.git"]);
    await gitText(mine, ["config", "core.sshCommand", ssh.path]);

    expect(ended(await sync(mine, "fetch"))).toBe(reason);
    expect(readFileSync(ssh.args, "utf8")).toContain("-o BatchMode=yes");
  });

  test("an https remote that wants a password fails as auth instead of waiting for one", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response("auth", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="x"' } }),
    });

    try {
      const { mine } = await setup();
      const url = `http://127.0.0.1:${server.port}/acme/app.git`;
      await gitText(mine, ["remote", "set-url", "origin", url]);

      const items = await sync(mine, "push");

      expect(ended(items)).toBe("auth");
    } finally {
      await server.stop(true);
    }
  }, 15_000);

  posixTest("the fake ssh's $$ is an MSYS pid, not one Windows can probe (ENG-318)")(
    "closing the stream stops git midway: no Done, and the remote is untouched",
    async () => {
      const { mine, bare } = await setup();
      const pidFile = join(tempDir("polaris-pid-"), "pid");
      const ssh = fakeSsh(`echo $$ > ${pidFile}; sleep 30`);
      await gitText(mine, ["remote", "set-url", "origin", "git@example.invalid:acme/app.git"]);
      await gitText(mine, ["config", "core.sshCommand", ssh.path]);
      write(mine, "c.txt", "c\n");
      await commitAll(mine, "mine");
      const remoteHead = await gitText(bare, ["rev-parse", "main"]);
      const started = Date.now();

      const items = await Effect.runPromise(
        Stream.runCollect(
          handleGitSync({ cwd: mine, action: "push" }).pipe(
            Stream.tap(() => Effect.promise(() => waitFor(() => existsSync(pidFile)))),
            Stream.take(1)
          )
        )
      );

      expect([...items].map((i) => i._tag)).toEqual(["Step"]);
      await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(await gitText(bare, ["rev-parse", "main"])).toBe(remoteHead);
    },
    15_000
  );
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean, ms = 8000) => {
  const until = Date.now() + ms;

  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
};
