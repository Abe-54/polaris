import { describe, expect, test } from "bun:test";
import { TurnItem } from "@polaris/protocol";
import { sandboxLaunchFailure } from "./launch.ts";

const command = (output: string, exitCode: number | null, status: "completed" | "failed") =>
  TurnItem.cases.CommandExecution.make({
    id: "cmd",
    command: "git log",
    cwd: "/repo",
    output,
    exitCode,
    status,
  });

describe("a sandbox that didn't start", () => {
  test.each([
    [
      "bubblewrap couldn't run the Harness",
      "bwrap: execvp /x/codex: No such file or directory\n",
      1,
      "failed",
      "bwrap: execvp /x/codex: No such file or directory",
    ],
    [
      "Codex couldn't build the bubblewrap command",
      "error building bubblewrap command: bad path",
      1,
      "completed",
      "error building bubblewrap command: bad path",
    ],
    [
      "macOS's sandbox refused to apply",
      "sandbox-exec: sandbox_apply: Operation not permitted",
      71,
      "completed",
      "sandbox-exec: sandbox_apply: Operation not permitted",
    ],
  ] as const)("is read from a failed command: %s", (_, output, exitCode, status, line) => {
    expect(sandboxLaunchFailure([command(output, exitCode, status)])).toBe(line);
  });

  test.each([
    ["a command that failed on its own", "fatal: not a git repository", 128, "failed"],
    [
      "a command that succeeded while printing bwrap's words",
      "bwrap: execvp is mentioned in this README",
      0,
      "completed",
    ],
    ["a mention mid-line", "grep found: bwrap: setting up uid map", 1, "failed"],
  ] as const)("isn't %s", (_, output, exitCode, status) => {
    expect(sandboxLaunchFailure([command(output, exitCode, status)])).toBeNull();
  });
});
