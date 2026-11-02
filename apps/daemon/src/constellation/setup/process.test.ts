import { afterEach, expect, test } from "bun:test";
import { ConstellationId, TaskId, WorktreeSetupRun } from "@polaris/protocol";
import { Effect } from "effect";
import { delimiter } from "node:path";
import { hostProgram, plantAll, ranOf } from "../../git/planted.testing.ts";
import { removeTempDir, tempDir } from "../../git/testing.ts";
import { executeSetup } from "./process.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

const run = (command: string, cwd: string) =>
  new WorktreeSetupRun({
    id: "setup-1",
    constellationId: ConstellationId.make("c-1"),
    taskId: TaskId.make("t-1"),
    command,
    cwd,
    fingerprint: null,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
  });

test("a setup's command is the Host's on PATH, never one planted in the worktree", async () => {
  const worktree = tempDir("polaris-setup-");
  const bin = tempDir("polaris-setup-bin-");
  dirs.push(worktree, bin);
  const planted = plantAll(worktree, "zzpolaris");
  hostProgram(bin, "zzpolaris", "host-program");
  // cmd.exe looks in its cwd first; sh reads an empty or `.` PATH entry as the cwd.
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const saved = process.env[key];
  process.env[key] = ["", ".", bin, saved ?? ""].join(delimiter);

  try {
    const done = await Effect.runPromise(Effect.scoped(executeSetup(run("zzpolaris", worktree))));

    expect({ output: done.output.trim(), exitCode: done.exitCode }).toEqual({
      output: "host-program",
      exitCode: 0,
    });
  } finally {
    process.env[key] = saved;
  }

  expect(ranOf(planted)).toEqual([]);
}, 30_000);
