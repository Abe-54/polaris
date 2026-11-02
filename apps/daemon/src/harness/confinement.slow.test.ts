import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isWithin } from "../files/fs.ts";
import { gitText } from "../git/git.ts";
import { makeRepo, removeDir, tempDir } from "../git/testing.ts";
import { readConfinement } from "./confinement.ts";
import { posixTest } from "../platform/testing.ts";

const cleanup: Array<string> = [];

const savedHome = process.env.POLARIS_HOME;

let polarisHome = "";

// The confined git's config is generated under Polaris's state, never the real ~/.polaris here.
beforeAll(() => {
  polarisHome = tempDir("polaris-confine-state-");
  process.env.POLARIS_HOME = polarisHome;
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = savedHome;
  removeDir(polarisHome);
});

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
  removeDir(join(polarisHome, "confined-git"));
});

const TOKEN = "ghp_reviewerMustNeverSeeThis";

const SANDBOX_GAP =
  "the Review Checkout's confined shell, its generated git config and its mode checks aren't built for Windows (ENG-296)";

const sandboxed = posixTest(SANDBOX_GAP);

const reviewCheckout = async () => {
  const repo = await makeRepo();
  const base = tempDir("polaris-confine-");
  cleanup.push(repo, base);
  await gitText(repo, ["remote", "add", "origin", `https://x:${TOKEN}@github.com/o/r.git`]);
  const checkout = join(base, "pr-7");
  await gitText(repo, ["worktree", "add", "-q", "--detach", checkout]);
  const common = realpathSync(join(repo, ".git"));
  const gitDir = realpathSync(await gitText(checkout, ["rev-parse", "--absolute-git-dir"]));

  return { repo, base, checkout, common, gitDir };
};

const covered = (roots: ReadonlyArray<string>, path: string) =>
  roots.some((root) => isWithin(root, path));

sandboxed(
  "a Review Checkout's shell reads a fixed toolchain, never the PATH's other directories, home or above it",
  async () => {
    const { base, checkout, common } = await reviewCheckout();
    const tools = join(base, "tools/bin");
    mkdirSync(tools, { recursive: true });
    const home = realpathSync(homedir());

    const confinement = await readConfinement(checkout, { PATH: [tools, home].join(delimiter) });
    const outsideGit = confinement.shellRoots.filter((root) => !isWithin(common, root));

    expect(confinement.root).toBe(checkout);
    expect(outsideGit).not.toContain(tools);

    for (const root of outsideGit) {
      expect(isWithin(root, home)).toBe(false);
      expect(isWithin(home, root)).toBe(false);
    }

    expect(covered([checkout, ...confinement.shellRoots], dirname(checkout))).toBe(false);
  }
);

sandboxed(
  "the shell's git reads history through a sanitized config, never one that can hold a credential",
  async () => {
    const { checkout, common, gitDir } = await reviewCheckout();
    // A worktree's own config is read only with this extension, and can name a remote too.
    await gitText(common, ["config", "extensions.worktreeConfig", "true"]);
    writeFileSync(
      join(gitDir, "config.worktree"),
      `[remote "fork"]\n\turl = https://x:${TOKEN}@github.com/f/r.git\n[credential]\n\thelper = store\n[include]\n\tpath = /tmp/elsewhere\n`
    );

    const confinement = await readConfinement(checkout, { PATH: "" });
    const env = { ...confinement.shellEnv };
    const readable = [confinement.root, ...confinement.shellRoots];

    for (const secret of [
      join(common, "config"),
      join(gitDir, "config.worktree"),
      join(common, "worktrees", "other"),
    ])
      expect(covered(readable, secret)).toBe(false);

    expect(await gitText(checkout, ["log", "--format=%s"], { env })).toBe("initial");
    const config = await gitText(checkout, ["config", "--list"], { env });
    expect(config).toContain("core.repositoryformatversion");

    for (const leak of [TOKEN, "credential.", "include.", "remote."])
      expect(config).not.toContain(leak);
  }
);

/** Plain git as the confined shell runs it: only the shell's git variables, no Polaris flags. */
const shellGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>
) => {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
  });

  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString() };
};

/** Keys git reads in the shell, whatever the repository's config holds besides its format. */
const ALLOWED = new Set([
  "core.repositoryformatversion",
  "core.bare",
  "core.worktree",
  "core.excludesfile",
  "core.attributesfile",
  "extensions.objectformat",
  "extensions.refstorage",
]);

sandboxed(
  "the shell's git config is built from an allowlist: a key that runs a program or names a file never reaches it",
  async () => {
    const { checkout, common } = await reviewCheckout();

    for (const [key, value] of [
      ["core.fsmonitor", "/tmp/evil"],
      ["core.hooksPath", "/tmp/hooks"],
      ["core.sshCommand", "/tmp/ssh"],
      ["core.pager", "/tmp/pager"],
      ["core.autocrlf", "true"],
      ["core.filemode", "false"],
      ["filter.lfs.process", "/tmp/filter"],
      ["diff.x.textconv", "/tmp/textconv"],
      ["url.https://evil/.insteadOf", "https://github.com/"],
      ["http.proxy", "http://evil:1"],
      ["include.path", "/tmp/elsewhere"],
      ["extensions.partialClone", "origin"],
    ] as const)
      await gitText(common, ["config", key, value]);

    const { shellEnv } = await readConfinement(checkout, { PATH: "" });
    const listed = shellGit(checkout, ["config", "--list", "--name-only"], shellEnv).out;

    expect(listed.split("\n").filter((key) => !ALLOWED.has(key))).toEqual([]);
    expect(shellGit(checkout, ["config", "core.worktree"], shellEnv).out).toBe(checkout);
    expect(shellGit(checkout, ["config", "core.bare"], shellEnv).out).toBe("false");
    expect(shellGit(checkout, ["status", "--porcelain"], shellEnv)).toMatchObject({
      code: 0,
      out: "",
    });
  }
);

test("a SHA-256 repository keeps its object format, so the shell's git still reads its history", async () => {
  const repo = tempDir("polaris-confine-sha256-");
  const base = tempDir("polaris-confine-");
  cleanup.push(repo, base);
  await gitText(repo, ["init", "-q", "-b", "main", "--object-format=sha256"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await gitText(repo, ["add", "-A"]);
  await gitText(repo, [
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@e",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  const checkout = join(base, "pr-8");
  await gitText(repo, ["worktree", "add", "-q", "--detach", checkout]);

  const { shellEnv } = await readConfinement(checkout, { PATH: "" });

  expect(shellGit(checkout, ["log", "--format=%s"], shellEnv)).toMatchObject({
    code: 0,
    out: "initial",
  });
});

sandboxed(
  "the shell's git reads a config generated outside the repository, which a later change to the repository can't reach",
  async () => {
    const { checkout, common, gitDir } = await reviewCheckout();

    const confinement = await readConfinement(checkout, { PATH: "" });
    const dir = confinement.shellEnv.GIT_COMMON_DIR ?? "";
    const generated = lstatSync(dir);

    expect(isWithin(realpathSync(join(polarisHome, "confined-git")), dir)).toBe(true);
    expect(isWithin(common, dir)).toBe(false);
    expect(generated.mode & 0o077).toBe(0);
    expect(confinement.shellEnv).toMatchObject({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });

    // Where the generated config lived inside the worktree's git dir, and the repository's own.
    mkdirSync(join(gitDir, "polaris-common"), { recursive: true });
    const planted = `[remote "origin"]\n\turl = https://x:${TOKEN}@h/r\n`;
    writeFileSync(join(gitDir, "polaris-common", "config"), planted);
    await gitText(common, ["config", "core.fsmonitor", "/tmp/evil"]);

    const config = shellGit(checkout, ["config", "--list"], confinement.shellEnv).out;

    expect(config).toContain("core.repositoryformatversion");

    for (const leak of [TOKEN, "remote.", "fsmonitor"]) expect(config).not.toContain(leak);
  }
);

// Skipped on Windows for SANDBOX_GAP.
(process.platform === "win32" ? test.skip : test).each([
  ["others can write", (dir: string) => (mkdirSync(dir), chmodSync(dir, 0o777))],
  ["is a link elsewhere", (dir: string) => symlinkSync(tempDir("polaris-confine-elsewhere-"), dir)],
])(
  "the reviewer doesn't start when Polaris's dir for the generated config %s",
  async (_, plant) => {
    const { checkout } = await reviewCheckout();
    plant(join(polarisHome, "confined-git"));

    const failure = await readConfinement(checkout, { PATH: "" }).then(() => null, String);

    expect(failure).toContain("others can write it");
  }
);

sandboxed(
  "a checkout that is the repository itself has its git dir hidden, and no git",
  async () => {
    const repo = await makeRepo();
    cleanup.push(repo);

    const confinement = await readConfinement(repo, { PATH: "" });

    expect(confinement.hidden).toContain(join(repo, ".git"));
    expect(confinement.shellEnv).not.toHaveProperty("GIT_COMMON_DIR");
  }
);

sandboxed("a Harness's config dir inside the checkout is hidden", async () => {
  const { checkout } = await reviewCheckout();
  const claude = join(checkout, ".claude-config");
  mkdirSync(claude);

  const confinement = await readConfinement(checkout, { PATH: "", CLAUDE_CONFIG_DIR: claude });

  expect(confinement.hidden).toContain(claude);
});

test("a checkout that holds the home directory can't be confined", async () => {
  const failure = await readConfinement(dirname(homedir()), { PATH: "" }).then(() => null, String);

  expect(failure).toContain("holds your home directory");
});

test("the shell's toolchain holds programs and libraries, never a prefix's configs or databases", async () => {
  const { checkout, common } = await reviewCheckout();

  const confinement = await readConfinement(checkout, { PATH: "" });
  const outsideGit = confinement.shellRoots.filter((root) => !isWithin(common, root));

  // Homebrew keeps Postgres's data dir in var and service passwords in etc, both the user's.
  for (const closed of [
    "/opt/homebrew/var/postgresql@17",
    "/opt/homebrew/etc/odbc.ini",
    "/usr/local/var/mysql",
    "/usr/local/etc/redis.conf",
    "/etc/shadow",
    "/tmp/other-session",
    "/Library/Keychains",
  ])
    expect(covered(outsideGit, closed)).toBe(false);
});

test("a checkout that holds the session's own home can't be confined either", async () => {
  const base = tempDir("polaris-confine-home-");
  cleanup.push(base);
  const home = join(base, "home");
  mkdirSync(home);

  const failure = await readConfinement(base, { PATH: "", HOME: home }).then(() => null, String);

  expect(failure).toContain("holds your home directory");
});

sandboxed(
  "a sandbox that opens the whole repository still finds its credentials and other worktrees closed",
  async () => {
    const { repo, base, checkout, common, gitDir } = await reviewCheckout();
    await gitText(repo, ["worktree", "add", "-q", "--detach", join(base, "other")]);
    const other = join(common, "worktrees", "other");
    writeFileSync(
      join(gitDir, "config.worktree"),
      `[remote "fork"]\n\turl = https://x:${TOKEN}@h/r\n`
    );

    const confinement = await readConfinement(checkout, { PATH: "" });

    for (const secret of [join(common, "config"), join(gitDir, "config.worktree"), other])
      expect(covered(confinement.hidden, secret)).toBe(true);
    expect(covered(confinement.hidden, join(common, "objects"))).toBe(false);
    expect(confinement.unwritable).toEqual([common, gitDir]);
  }
);
