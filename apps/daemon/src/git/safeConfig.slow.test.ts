import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import { Effect } from "effect";
import { makeFakeBlobChannel } from "../files/testing.ts";
import { DiffSpec } from "./diff.ts";
import { handleGitDiff, handleGitStatus } from "./GitRpcs.ts";
import { GitOutputTooLarge, gitText, HOOKS_OFF, runGitRaw } from "./git.ts";
import { pinCommits } from "./review/fetch.ts";
import { reviewRef } from "./review/refs.ts";
import {
  NO_HOOKS_PATH,
  noHooksPath,
  parseListing,
  repositoryOverrides,
} from "./safeConfig/index.ts";
import { showFile } from "./show.ts";
import { snapshotWorkingTree } from "./snapshot.ts";
import { commitAll, makeRepo, removeDir, tempDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeDir(dir);
});

const dir = (made: string) => {
  cleanup.push(made);

  return made;
};

/** Git for Windows runs these through sh, which reads a backslash as an escape. */
const shellPath = (path: string) => path.replaceAll("\\", "/");

/** A script that leaves `<name>.ran` in `markers` and passes its stdin through. */
const script = (markers: string, name: string) => {
  const path = join(markers, name);
  write(markers, name, `#!/bin/sh\ntouch "${shellPath(markers)}/${name}.ran"\ncat\n`);
  chmodSync(path, 0o755);

  return shellPath(path);
};

const ran = (markers: string) =>
  readdirSync(markers)
    .filter((f) => f.endsWith(".ran"))
    .map((f) => f.replace(/\.ran$/, ""))
    .sort();

/** A Workspace that arrived with its own `.git/config`: every setting here names a command. */
const prepared = async () => {
  const markers = dir(tempDir("polaris-markers-"));

  const root = dir(
    await makeRepo({ "a.txt": "a\n", ".gitattributes": "*.txt filter=evil diff=evil\n" })
  );

  const set = (key: string, value: string) => gitText(root, ["config", key, value]);

  await set("core.fsmonitor", script(markers, "fsmonitor"));
  await set("filter.evil.clean", script(markers, "clean"));
  await set("diff.evil.textconv", script(markers, "textconv"));
  await set("diff.external", script(markers, "external"));
  write(root, "a.txt", "b\n");

  return { root, markers };
};

describe("automatic git in a Workspace's repository", () => {
  test("the explorer's status runs none of the commands the repository's config names", async () => {
    const { root, markers } = await prepared();

    const status = await Effect.runPromise(handleGitStatus({ cwd: root }));

    expect(status.entries.map((e) => `${e.worktree} ${e.path}`)).toEqual(["M a.txt"]);
    expect(ran(markers)).toEqual([]);

    // The control: with the Host's config as it is, git runs them.
    await runGitRaw(root, ["status", "--porcelain"], { config: "host" });
    expect(ran(markers)).toEqual(["clean", "fsmonitor"]);
  });

  test("a working-tree diff snapshots and diffs without a filter, textconv or external diff", async () => {
    const { root, markers } = await prepared();
    const blobs = makeFakeBlobChannel();

    const result = await Effect.runPromise(
      handleGitDiff({ cwd: root, spec: DiffSpec.cases.WorkingTree.make({ base: null }) }).pipe(
        Effect.provide(blobs.layer)
      )
    );

    expect(new TextDecoder().decode(blobs.blobs.get(result.blobId))).toContain("-a\n+b\n");
    expect(ran(markers)).toEqual([]);

    await runGitRaw(root, ["diff"], { config: "host" });
    expect(ran(markers)).toEqual(["clean", "external", "fsmonitor"]);
  });

  test("a filter the repository's config gains later is turned off too", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n", ".gitattributes": "*.txt filter=late\n" }));
    await gitText(root, ["status", "--porcelain"]);

    await gitText(root, ["config", "filter.late.clean", script(markers, "late")]);
    write(root, "a.txt", "b\n");
    await gitText(root, ["status", "--porcelain"]);

    expect(ran(markers)).toEqual([]);
  });

  test("pinning a session's Turns for Review runs no hook, even through a relative hooksPath", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    const base = await gitText(root, ["rev-parse", "HEAD"]);
    write(root, "a.txt", "b\n");
    const head = await commitAll(root, "turn");
    write(root, ".hooks/reference-transaction", `#!/bin/sh\ntouch "${root}/hook.ran"\n`);
    chmodSync(join(root, ".hooks/reference-transaction"), 0o755);
    await gitText(root, ["config", "core.hooksPath", ".hooks"]);

    await pinCommits({ repoPath: root, key: "session-s1", head, base });

    expect(await gitText(root, ["rev-parse", reviewRef("session-s1", "head")])).toBe(head);
    expect(existsSync(join(root, "hook.ran"))).toBe(false);
  });
});

describe("the hooks path Polaris pins", () => {
  test.each([
    ["darwin", "/usr/local/bin/polaris"],
    ["linux", "/home/u/.polaris/bin/current/polaris"],
    ["win32", "C:\\Users\\u\\.polaris\\bin\\0.2.0\\polaris.exe"],
  ])("on %s it is absolute, so git never resolves it in the working tree", (os, execPath) => {
    const isAbsolute = os === "win32" ? win32.isAbsolute : posix.isAbsolute;

    expect(isAbsolute(noHooksPath(os, execPath))).toBe(true);
  });

  test("here it names something that exists and is no directory, so it holds no hook", () => {
    expect(isAbsolute(NO_HOOKS_PATH)).toBe(true);
    expect(statSync(NO_HOOKS_PATH).isDirectory()).toBe(false);
  });

  test("a commit runs neither the repository's hooks nor one planted where the path would resolve", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    const marker = join(root, "hook.ran").replaceAll("\\", "/");
    const hook = `#!/bin/sh\necho "$0" >> "${marker}"\n`;
    // The value read relative to the working tree, as git would read a relative one.
    const planted = join(root, NO_HOOKS_PATH.replace(/^[A-Za-z]:/, ""), "pre-commit");
    const longPath = (path: string) => (process.platform === "win32" ? `\\\\?\\${path}` : path);

    for (const path of [join(root, ".git", "hooks", "pre-commit"), planted]) {
      mkdirSync(longPath(dirname(path)), { recursive: true });
      writeFileSync(longPath(path), hook);
      chmodSync(longPath(path), 0o755);
    }

    await gitText(root, [...HOOKS_OFF, "commit", "-q", "--allow-empty", "-m", "no hooks"]);

    expect(await gitText(root, ["log", "-1", "--format=%s"])).toBe("no hooks");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("where git reads its config from", () => {
  test("a Workspace folder git doesn't take as a repository still gets its parent's drivers turned off", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n", ".gitattributes": "*.txt filter=late\n" }));
    // An empty `.git` isn't a repository: git reads `root`'s config from here.
    mkdirSync(join(root, "pkg/.git"), { recursive: true });
    const pkg = join(root, "pkg");
    await gitText(pkg, ["status", "--porcelain"]);

    await gitText(root, ["config", "filter.late.clean", script(markers, "late")]);
    write(root, "a.txt", "b\n");
    await gitText(pkg, ["status", "--porcelain"]);

    expect(ran(markers)).toEqual([]);
  });

  test("a repository that appears inside the Workspace's is read from then on", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    write(root, "pkg/b.txt", "b\n");
    const pkg = join(root, "pkg");
    await gitText(pkg, ["status", "--porcelain"]);

    await gitText(pkg, ["init", "-q"]);
    write(pkg, ".gitattributes", "*.txt filter=inner\n");
    await gitText(pkg, ["add", "-A"]);
    await gitText(pkg, ["config", "filter.inner.clean", script(markers, "clean")]);
    write(pkg, "b.txt", "c\n");
    await gitText(pkg, ["status", "--porcelain"]);

    expect(ran(markers)).toEqual([]);
  });

  test("a driver added to a file the repository's config includes is turned off too", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n", ".gitattributes": "*.txt filter=late\n" }));
    write(root, ".git/extra.cfg", "");
    await gitText(root, ["config", "include.path", "extra.cfg"]);
    await gitText(root, ["status", "--porcelain"]);

    write(root, ".git/extra.cfg", `[filter "late"]\n\tclean = ${script(markers, "late")}\n`);
    write(root, "a.txt", "b\n");
    await gitText(root, ["status", "--porcelain"]);

    expect(ran(markers)).toEqual([]);
  });

  // Each starts missing, so the first listing names none of them.
  const lateHostFiles = [
    ["the XDG config", "", "xdg/git/config"],
    ["a file the global config includes", "[include]\n\tpath = extra\n", "extra"],
  ] as const;

  test.each(lateHostFiles)(
    "%s, written after a call, is read by the next",
    async (_name, global, late) => {
      const home = dir(tempDir("polaris-home-"));
      const root = dir(await makeRepo({ "a.txt": "a\n" }));
      await gitText(root, ["config", "core.sshCommand", "evil-ssh"]);
      write(home, ".gitconfig", global);
      const env = { HOME: home, XDG_CONFIG_HOME: join(home, "xdg") };
      expect(await gitText(root, ["config", "--get", "core.sshCommand"], { env })).toBe("ssh");

      write(home, late, "[core]\n\tsshCommand = host-ssh\n");

      expect(await gitText(root, ["config", "--get", "core.sshCommand"], { env })).toBe("host-ssh");
    }
  );

  test("a `-C` in the arguments reads that repository's drivers, not the cwd's", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const elsewhere = dir(tempDir("polaris-cwd-"));
    const root = dir(await makeRepo({ "a.txt": "a\n", ".gitattributes": "*.txt filter=evil\n" }));
    await gitText(root, ["config", "filter.evil.clean", script(markers, "clean")]);
    write(root, "a.txt", "b\n");

    await gitText(elsewhere, ["-C", root, "status", "--porcelain"]);

    expect(ran(markers)).toEqual([]);
  });
});

/** A Workspace whose submodule arrived with its own config naming a filter and an fsmonitor. */
const withSubmodule = async () => {
  const markers = dir(tempDir("polaris-markers-"));
  const source = dir(await makeRepo({ "s.txt": "s\n", ".gitattributes": "*.txt filter=inner\n" }));
  const root = dir(await makeRepo({ "a.txt": "a\n" }));

  await gitText(
    root,
    ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"],
    {
      config: "host",
    }
  );

  await commitAll(root, "submodule");
  const sub = join(root, "sub");

  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ]) {
    await gitText(sub, ["config", key ?? "", value ?? ""]);
  }

  await gitText(sub, ["config", "filter.inner.clean", script(markers, "clean")]);
  await gitText(sub, ["config", "core.fsmonitor", script(markers, "fsmonitor")]);
  write(sub, "s.txt", "t\n");

  return { root, markers };
};

describe("automatic git never goes into a submodule", () => {
  test("the explorer's status, a working-tree diff and a checkpoint snapshot run none of its commands", async () => {
    const { root, markers } = await withSubmodule();
    const blobs = makeFakeBlobChannel();

    await Effect.runPromise(handleGitStatus({ cwd: root }));
    await Effect.runPromise(
      handleGitDiff({ cwd: root, spec: DiffSpec.cases.WorkingTree.make({ base: null }) }).pipe(
        Effect.provide(blobs.layer)
      )
    );
    const snapshot = await snapshotWorkingTree(root);

    expect(ran(markers)).toEqual([]);
    expect(await gitText(root, ["ls-tree", "--name-only", snapshot?.tree ?? ""])).toBe(
      ".gitmodules\na.txt\nsub"
    );

    // The control: git as the Host has it runs the submodule's commands. Git for Windows
    // trusts the submodule's index stat there and skips the filter, but still runs the fsmonitor.
    await runGitRaw(root, ["status", "--porcelain"], { config: "host" });
    expect(ran(markers)).toEqual(
      process.platform === "win32" ? ["fsmonitor"] : ["clean", "fsmonitor"]
    );
  }, 30_000);

  test("a submodule moved to another commit still shows as changed", async () => {
    const { root } = await withSubmodule();
    await gitText(join(root, "sub"), ["commit", "-qam", "moved"]);

    const status = await Effect.runPromise(handleGitStatus({ cwd: root }));

    expect(status.entries.map((e) => `${e.worktree} ${e.path}`)).toEqual(["M sub"]);
  });
});

/** A config file of the Host's own (the user's global config), for `GIT_CONFIG_GLOBAL`. */
const hostConfig = (lines: string) => {
  const home = dir(tempDir("polaris-home-"));
  write(home, "gitconfig", lines);

  return { GIT_CONFIG_GLOBAL: join(home, "gitconfig") };
};

/** The value git uses: the last one set. */
const effective = (
  root: string,
  key: string,
  options: { readonly env: Record<string, string>; readonly config?: "trusted-fetch" }
) => gitText(root, ["config", "--get", key], options);

describe("network settings on automatic git", () => {
  test("the repository's credential helper and ssh command give way to the Host's", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    await gitText(root, ["config", "credential.https://github.com.helper", "!evil-helper"]);
    await gitText(root, ["config", "core.sshCommand", "evil-ssh"]);

    const env = hostConfig(
      "[credential]\n\thelper = host-helper\n[core]\n\tsshCommand = host-ssh\n"
    );

    const helpers = (
      await gitText(root, ["config", "--get-regexp", "^credential\\..*helper$"], { env })
    ).split("\n");

    const inUse = helpers.slice(helpers.lastIndexOf("credential.helper "));

    expect(inUse).toContain("credential.helper host-helper");
    expect(inUse.join("\n")).not.toContain("evil");
    expect(await effective(root, "core.sshCommand", { env })).toBe("host-ssh");

    // A Review fetch in a trusted Workspace keeps them: per-repository deploy keys and helpers.
    expect(await effective(root, "core.sshCommand", { env, config: "trusted-fetch" })).toBe(
      "evil-ssh"
    );
  });

  test("a fetch from a local remote never runs the upload-pack the repository's config names", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const upstream = dir(await makeRepo({ "a.txt": "a\n" }));
    const root = dir(await makeRepo({ "b.txt": "b\n" }));
    await gitText(root, ["remote", "add", "origin", upstream]);
    await gitText(root, [
      "config",
      "remote.origin.uploadpack",
      `${script(markers, "upload")}; git-upload-pack`,
    ]);

    await gitText(root, ["fetch", "-q", "origin", "main:refs/polaris/test/safe"]);
    await gitText(root, ["fetch", "-q", "origin", "main:refs/polaris/test/main"], {
      config: "trusted-fetch",
    });

    expect(ran(markers)).toEqual([]);
    expect(await gitText(root, ["rev-parse", "refs/polaris/test/main"])).toBe(
      await gitText(upstream, ["rev-parse", "HEAD"])
    );
  });
});

describe("a git:// remote", () => {
  test("never runs the proxy command the repository's config names, unless a trusted Review fetch", async () => {
    const markers = dir(tempDir("polaris-markers-"));
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    // Nothing listens on port 1: the fetch fails either way, after the proxy would run.
    await gitText(root, ["remote", "add", "origin", "git://127.0.0.1:1/app.git"]);
    await gitText(root, ["config", "core.gitProxy", script(markers, "proxy")]);

    await runGitRaw(root, ["fetch", "-q", "origin"]);
    expect(ran(markers)).toEqual([]);

    await runGitRaw(root, ["fetch", "-q", "origin"], { config: "trusted-fetch" });
    expect(ran(markers)).toEqual(["proxy"]);
  });
});

describe("repositoryOverrides", () => {
  test("turns off the repository's drivers, keeps the user's own and git-lfs's", () => {
    const entries = parseListing(
      [
        "global",
        "file:x",
        "filter.lfs.clean\ngit-lfs clean -- %f",
        "global",
        "file:x",
        "filter.mine.clean\nmy-clean",
        "local",
        "file:x",
        "filter.lfs.process\ngit-lfs filter-process",
        "local",
        "file:x",
        "filter.evil.smudge\nrm -rf ~",
        "worktree",
        "file:x",
        "merge.evil.driver\nsh evil.sh",
        "local",
        "file:x",
        "core.bare\nfalse",
        "",
      ].join("\0")
    );

    expect(repositoryOverrides(entries, "safe")).toEqual([
      ["filter.evil.smudge", ""],
      ["merge.evil.driver", ""],
    ]);
  });

  test("without a repository credential helper or ssh command, the Host's stand as they are", () => {
    const entries = parseListing(
      "global\0file:g\0credential.helper\nosxkeychain\0global\0file:g\0core.sshcommand\nssh -i k\0"
    );

    expect(repositoryOverrides(entries, "safe")).toEqual([]);
  });
});

describe("output limits", () => {
  test("git that prints past its limit is stopped, and the call fails as too large", async () => {
    const root = dir(await makeRepo({ "big.txt": "x".repeat(1024 * 1024) }));

    const failure = await runGitRaw(root, ["cat-file", "blob", "HEAD:big.txt"], {
      maxOutputBytes: 64 * 1024,
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(GitOutputTooLarge);
  });

  test("git.show refuses a file past its limit in the words the Desktop App shows", async () => {
    const root = dir(await makeRepo({ "a.txt": "a\n" }));
    write(root, "huge.bin", "\0".repeat(65 * 1024 * 1024));
    await commitAll(root, "huge");

    const failure = await showFile(root, "HEAD", "huge.bin").catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(GitOutputTooLarge);
    expect(failure).toMatchObject({ message: "This file is larger than 64 MB, too large to show" });
  });
});
