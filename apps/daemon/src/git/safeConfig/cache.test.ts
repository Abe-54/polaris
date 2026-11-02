/**
 * The cached config listing on real repositories: kept while nothing git reads for it
 * changed (a branch switch, an inert `-c`), read again when something did.
 */
import { afterEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { posixTest } from "../../platform/testing.ts";
import { gitExecutable } from "../executable.ts";
import { gitText, HOOKS_OFF } from "../git.ts";
import { makeRepo, removeTempDir, tempDir, write } from "../testing.ts";

/** Git for Windows reads config values and runs drivers through sh: no backslashes. */
const forward = (path: string) => path.replaceAll("\\", "/");

const linkTest = posixTest("its HEAD link targets hold `|`, which no Windows path may");

const cleanup: Array<string> = [];

const spies: Array<Mock<typeof Bun.spawn>> = [];

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();

  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const dir = (made: string) => {
  cleanup.push(made);

  return made;
};

/** Watches every git the Daemon starts from here; answers how many ran with all of `words`. */
const countGits = (...words: Array<string>) => {
  const spawn = spyOn(Bun, "spawn");
  spies.push(spawn);

  return () =>
    spawn.mock.calls.filter(([command]) => {
      const argv = Array.isArray(command) ? command : [];

      return argv[0] === gitExecutable() && words.every((word) => argv.includes(word));
    }).length;
};

const countListings = () => countGits("config", "--list");

describe("the cached config listing", () => {
  test("survives a branch switch and a commit on a detached HEAD", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(root, ["status", "--porcelain"]);
    const listings = countListings();

    await gitText(root, ["branch", "other"]);
    await gitText(root, ["symbolic-ref", "HEAD", "refs/heads/other"]);
    await gitText(root, ["status", "--porcelain"]);
    const head = await gitText(root, ["rev-parse", "HEAD"]);
    await gitText(root, ["update-ref", "--no-deref", "HEAD", head]);
    await gitText(root, ["status", "--porcelain"]);

    expect(listings()).toBe(0);
  });

  test("is shared by a call with the Daemon's inert `-c` settings", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(root, ["status", "--porcelain"]);
    const listings = countListings();

    await gitText(root, ["-c", "core.splitIndex=false", "-c", "index.skipHash=true", "status"]);
    await gitText(root, [...HOOKS_OFF, "status", "--porcelain"]);

    expect(listings()).toBe(0);
  });

  test("of a new repository is read, but where the Host's config lives is asked once", async () => {
    const first = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(first, ["status", "--porcelain"]);
    const listings = countListings();
    const asked = countGits("var");

    const second = dir(await makeRepo({ "b.txt": "b\n" }));
    await gitText(second, ["status", "--porcelain"]);

    expect(listings()).toBeGreaterThan(0);
    expect(asked()).toBe(0);
  });

  test("is read again when the branch decides a Host include", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(root, ["config", "core.sshCommand", "evil-ssh"]);
    const home = dir(tempDir("polaris-home-"));
    write(home, "feature", "[core]\n\tsshCommand = feature-ssh\n");
    write(
      home,
      "gitconfig",
      `[includeIf "onbranch:feature"]\n\tpath = ${forward(join(home, "feature"))}\n`
    );
    const env = { GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
    const ssh = () => gitText(root, ["config", "--get", "core.sshCommand"], { env });
    expect(await ssh()).toBe("ssh");

    await gitText(root, ["branch", "feature"]);
    await gitText(root, ["symbolic-ref", "HEAD", "refs/heads/feature"]);

    expect(await ssh()).toBe("feature-ssh");
  });

  test("is read again when a folder's HEAD becomes valid and git takes it as a repository", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    const pkg = join(root, "pkg");

    // A `.git` git passes over: everything a repository has but a HEAD it takes.
    for (const sub of ["objects", "refs/heads"])
      mkdirSync(join(pkg, ".git", sub), { recursive: true });
    write(pkg, ".git/HEAD", "not a head\n");
    write(pkg, "b.txt", "b\n");
    await gitText(pkg, ["status", "--porcelain"]);

    const clean = forward(join(markers, "clean"));
    write(markers, "clean", `#!/bin/sh\ntouch "${clean}.ran"\ncat\n`);
    chmodSync(clean, 0o755);
    write(pkg, ".git/config", `[filter "inner"]\n\tclean = ${clean}\n`);
    write(pkg, ".gitattributes", "*.txt filter=inner\n");
    write(pkg, ".git/HEAD", "ref: refs/heads/main\n");
    await gitText(pkg, ["add", "-A"]);

    expect(resolve(await gitText(pkg, ["rev-parse", "--show-toplevel"]))).toBe(pkg);
    expect(existsSync(`${clean}.ran`)).toBe(false);
  });

  test("is read again when a symlinked HEAD comes to point into refs/", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    const pkg = join(root, "pkg");
    const head = join(pkg, ".git", "HEAD");

    // The same bytes behind both links: only where HEAD points tells git it's a repository.
    for (const sub of ["objects", "refs/heads"])
      mkdirSync(join(pkg, ".git", sub), { recursive: true });
    write(pkg, ".git/decoy", "ref: refs/heads/main\n");
    write(pkg, ".git/refs/heads/main", "ref: refs/heads/main\n");
    symlinkSync("decoy", head);
    write(pkg, "b.txt", "b\n");
    await gitText(pkg, ["status", "--porcelain"]);

    const clean = forward(join(markers, "clean"));
    write(markers, "clean", `#!/bin/sh\ntouch "${clean}.ran"\ncat\n`);
    chmodSync(clean, 0o755);
    write(pkg, ".git/config", `[filter "inner"]\n\tclean = ${clean}\n`);
    write(pkg, ".gitattributes", "*.txt filter=inner\n");
    rmSync(head);
    symlinkSync("refs/heads/main", head);
    await gitText(pkg, ["add", "-A"]).catch(() => "");

    expect(existsSync(`${clean}.ran`)).toBe(false);
  });

  linkTest("tells two HEAD links apart when one target ends where the next begins", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    const pkg = join(root, "pkg");
    const uid = process.getuid?.() ?? 0;

    // Joined plainly, `x|l<uid>:refs/y` + absent reads the same as `x` + `refs/y|-`.
    for (const sub of ["objects", "refs", ".git/objects", ".git/refs"])
      mkdirSync(join(pkg, sub), { recursive: true });
    symlinkSync(`x|l${uid}:refs/y`, join(pkg, ".git", "HEAD"));
    expect(await gitText(pkg, ["rev-parse", "--show-toplevel"])).toBe(root);
    const listings = countListings();

    rmSync(join(pkg, ".git", "HEAD"));
    symlinkSync("x", join(pkg, ".git", "HEAD"));
    symlinkSync("refs/y|-", join(pkg, "HEAD"));
    await gitText(pkg, ["rev-parse", "--git-dir"]);

    expect(listings()).toBeGreaterThan(0);
  });
});
