import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { commitAll, removeTempDir, write } from "../git/testing.ts";
import { gitText } from "../git/git.ts";
import { tempDir } from "../engine/testing.ts";
import {
  isIgnored,
  parseInstructions,
  privateInstructionsPath,
  readInstructions,
} from "./instructions.ts";

const cleanup: Array<string> = [];

const home = process.env.POLARIS_HOME;

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);

  if (home === undefined) delete process.env.POLARIS_HOME;
  else process.env.POLARIS_HOME = home;
});

describe("review instructions", () => {
  test("front-matter lists ignored paths; the body is the instructions", () => {
    const parsed = parseInstructions(
      "---\nignore:\n  - dist/**\n  - '*.lock'\n---\nBe strict about SQL.\n"
    );

    expect(parsed).toEqual({ text: "Be strict about SQL.", ignore: ["dist/**", "*.lock"] });
    expect(parseInstructions("No front-matter.")).toEqual({ text: "No front-matter.", ignore: [] });
    expect(parseInstructions("---\n: [\n---\nBody")).toEqual({ text: "Body", ignore: [] });
  });

  test("globs match paths", () => {
    expect(isIgnored(["dist/**"], "dist/a/b.js")).toBe(true);
    expect(isIgnored(["dist/**"], "src/dist.ts")).toBe(false);
  });

  test("the committed file at head comes first, then the private file", async () => {
    const repo = tempDir();
    const polarisHome = tempDir();
    cleanup.push(repo, polarisHome);
    process.env.POLARIS_HOME = polarisHome;
    await gitText(repo, ["init", "-q", "-b", "main"]);
    await gitText(repo, ["config", "user.email", "t@example.com"]);
    await gitText(repo, ["config", "user.name", "T"]);
    await gitText(repo, ["config", "commit.gpgsign", "false"]);
    await gitText(repo, ["remote", "add", "origin", "git@github.com:Acme/App.git"]);
    write(repo, ".polaris/review.md", "---\nignore: [vendor/**]\n---\nCommitted rules.\n");
    const head = await commitAll(repo, "instructions");
    write(repo, ".polaris/review.md", "Uncommitted edit.\n");

    const privatePath = privateInstructionsPath("github.com/acme/app");
    mkdirSync(dirname(privatePath), { recursive: true });
    writeFileSync(privatePath, "---\nignore: [gen/**]\n---\nMy own notes.\n");

    const read = await readInstructions({ cwd: repo, head, repo });

    expect(read).toEqual({
      text: "Committed rules.\n\nMy own notes.",
      ignore: ["vendor/**", "gen/**"],
    });
    expect(join(polarisHome, "review", "github.com/acme/app.md")).toBe(privatePath);
  });
});
