import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { GitCommitItem, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import { captureCheckpoint } from "./Checkpoints.ts";
import { computeDiff, DiffSpec } from "./diff.ts";
import { gitText } from "./git.ts";
import { handleGitCommit, handleGitStage } from "./GitRpcs.ts";
import { removeTempDir, tempDir, write } from "./testing.ts";

const cleanup: Array<string> = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) removeTempDir(dir);
});

/** Long, yet short enough for git's own working directory (about 248 on Windows). */
const WORKSPACE_LENGTH = 215;

/** A Workspace whose `.git/objects/xx/…` files pass Windows' MAX_PATH of 260. */
const longWorkspace = async () => {
  const base = tempDir("polaris-long-");
  cleanup.push(base);
  const root = join(base, "w".repeat(WORKSPACE_LENGTH - base.length - 1));
  mkdirSync(root);
  await gitText(root, ["init", "-q", "-b", "main"]);
  appendFileSync(
    join(root, ".git/config"),
    "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n" +
      "[core]\n\tautocrlf = false\n\thooksPath = .git/hooks\n"
  );

  return root;
};

test("a Workspace whose git files pass MAX_PATH stages, commits and checkpoints", async () => {
  const root = await longWorkspace();
  write(root, "a.txt", "a\n");

  await Effect.runPromise(handleGitStage({ cwd: root, paths: ["a.txt"] }));

  const items = await Effect.runPromise(
    Stream.runCollect(handleGitCommit({ cwd: root, message: "initial" }))
  );

  expect([...items].at(-1)).toEqual(
    GitCommitItem.cases.Committed.make({ head: await gitText(root, ["rev-parse", "HEAD"]) })
  );

  const sessionId = SessionId.make("dispatch-1790915668002-1:T4:worker");
  const turnId = TurnId.make("dispatch-1790915668002-1:T4:attempt:start");
  await captureCheckpoint({ cwd: root, sessionId, turnId, label: "before" });
  write(root, "a.txt", "agent edit\n");
  await captureCheckpoint({ cwd: root, sessionId, turnId, label: "after" });

  const diff = await computeDiff(root, DiffSpec.cases.Turn.make({ sessionId, turnId }));
  expect(new TextDecoder().decode(diff.bytes)).toContain("+agent edit");
});
