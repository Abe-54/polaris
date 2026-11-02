import { describe, expect, test } from "bun:test";
import { TurnItem } from "@polaris/protocol";
import { sandboxLaunchFailure } from "./launch.ts";

const command = (
  output: string,
  exitCode: number | null,
  status: "completed" | "failed" | "declined" = "failed"
) =>
  TurnItem.cases.CommandExecution.make({
    id: "cmd",
    command: "git log",
    cwd: "/repo",
    output,
    exitCode,
    status,
  });

const NOT_FOUND = "bwrap: execvp /x/codex: No such file or directory";

describe("a sandbox that didn't start", () => {
  test.each([
    ["bubblewrap couldn't run the Harness", `${NOT_FOUND}\n`, 1, NOT_FOUND],
    [
      "Codex couldn't build the bubblewrap command",
      "error building bubblewrap command: bad path",
      1,
      "error building bubblewrap command: bad path",
    ],
    [
      "macOS's sandbox couldn't exec",
      "sandbox-exec: execvp() of '/x/git' failed: No such file or directory",
      71,
      "sandbox-exec: execvp() of '/x/git' failed: No such file or directory",
    ],
  ] as const)(
    "is read from a command that printed only its error: %s",
    (_, output, exitCode, line) => {
      expect(sandboxLaunchFailure([command(output, exitCode)])).toBe(line);
    }
  );

  test("is read when every command failed that way, declined ones aside", () => {
    expect(
      sandboxLaunchFailure([
        command(NOT_FOUND, 1),
        command("", null, "declined"),
        command(NOT_FOUND, 1),
      ])
    ).toBe(NOT_FOUND);
  });

  // A reviewed change controls what its scripts print; mimicking bwrap must not fail the review.
  test.each([
    ["a command that failed on its own", [command("fatal: not a git repository", 128)]],
    ["bwrap's words and an exit 0", [command(NOT_FOUND, 0, "completed")]],
    ["bwrap's words and another exit code", [command(NOT_FOUND, 2)]],
    ["bwrap's line followed by more output", [command(`${NOT_FOUND}\nnpm ERR! test failed`, 1)]],
    ["bwrap's line after other output", [command(`> test\n${NOT_FOUND}`, 1)]],
    ["a mention mid-line", [command("grep found: bwrap: setting up uid map", 1)]],
    [
      "one launch failure beside a command that ran",
      [command(NOT_FOUND, 1), command("ok", 0, "completed")],
    ],
    ["no command at all", []],
  ] as const)("isn't %s", (_, items) => {
    expect(sandboxLaunchFailure(items)).toBeNull();
  });
});
