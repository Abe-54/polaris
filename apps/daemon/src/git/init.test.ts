import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { handleGitInit } from "./GitRpcs.ts";
import { gitText } from "./git.ts";
import { removeTempDir, tempDir } from "./testing.ts";

const cleanup: Array<string> = [];

const saved = { ...process.env };

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);

  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A new empty folder, with the Host's global git config replaced by `config`. */
const newFolder = (config: string) => {
  const root = tempDir("polaris-init-");
  cleanup.push(root);
  const global = join(root, "gitconfig");
  writeFileSync(global, `${config}[commit]\n\tgpgsign = false\n`);
  process.env.GIT_CONFIG_GLOBAL = global;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const folder = join(root, "atlas");
  mkdirSync(folder);

  return folder;
};

describe("git.init", () => {
  test("a first commit a new worktree can branch from", async () => {
    const folder = newFolder("[user]\n\tname = Ada\n\temail = ada@example.com\n");
    const made = await Effect.runPromise(handleGitInit({ path: folder }));

    expect(made.note).toBeNull();
    expect(made.head).toBe(await gitText(folder, ["rev-parse", "HEAD"]));

    await gitText(folder, ["worktree", "add", "-q", "-b", "polaris/first", `${folder}.wt`]);
    cleanup.push(`${folder}.wt`);
    expect(existsSync(join(`${folder}.wt`, ".git"))).toBe(true);
  });

  test("without an identity the repository stays, with no commit and git's reason", async () => {
    const folder = newFolder("[user]\n\tuseConfigOnly = true\n");
    const made = await Effect.runPromise(handleGitInit({ path: folder }));

    expect(made.head).toBeNull();
    expect(made.note).toBe("git has no user.name and user.email set to commit with");
    expect(existsSync(join(folder, ".git"))).toBe(true);
  });
});
