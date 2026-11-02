import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../engine/testing.ts";
import { gitText } from "../git/git.ts";
import { commitAll, removeTempDir, write } from "../git/testing.ts";
import { composeTurns } from "./compose.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

const repo = async () => {
  const dir = tempDir();
  cleanup.push(dir);
  await gitText(dir, ["init", "-q", "-b", "main"]);
  await gitText(dir, ["config", "user.email", "t@example.com"]);
  await gitText(dir, ["config", "user.name", "T"]);
  await gitText(dir, ["config", "commit.gpgsign", "false"]);
  write(dir, "a.txt", "a0\n");
  write(dir, "gone.txt", "bye\n");

  return { dir, start: await commitAll(dir, "start") };
};

describe("composing an Agent Session's change from its Turns", () => {
  test("each file from before the first Turn that touched it to after the last; others' work stays out", async () => {
    const { dir, start } = await repo();
    write(dir, "a.txt", "a1\n");
    rmSync(join(dir, "gone.txt"));
    const t1 = await commitAll(dir, "turn 1");
    write(dir, "theirs.txt", "not the session's\n");
    const between = await commitAll(dir, "someone else");
    write(dir, "a.txt", "a2\n");
    write(dir, "b.txt", "b2\n");
    const t2 = await commitAll(dir, "turn 2");

    const change = await composeTurns(dir, [
      { before: start, after: t1 },
      { before: between, after: t2 },
    ]);

    expect(await gitText(dir, ["diff", "--name-status", change.base, change.head])).toBe(
      "M\ta.txt\nA\tb.txt\nD\tgone.txt"
    );
    expect(await gitText(dir, ["show", `${change.base}:a.txt`])).toBe("a0");
    expect(await gitText(dir, ["show", `${change.head}:a.txt`])).toBe("a2");
  });
});
