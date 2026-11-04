import { describe, expect, test } from "bun:test";
import { shellArgv } from "./shellRun.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

const PWSH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const windows = (
  files: ReadonlyArray<string>,
  env: Record<string, string> = {},
  git: string | null = null
) => ({
  env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", ...env },
  exists: (path: string) => files.includes(path),
  gitOnPath: () => git,
});

describe("the shell a shell command runs in on Windows", () => {
  test.each([
    ["Git for Windows' install", [GIT_BASH], {}, null, GIT_BASH],
    [
      "CLAUDE_CODE_GIT_BASH_PATH, before the install",
      [GIT_BASH, "D:\\msys\\usr\\bin\\bash.exe"],
      { CLAUDE_CODE_GIT_BASH_PATH: "D:\\msys\\usr\\bin\\bash.exe" },
      null,
      "D:\\msys\\usr\\bin\\bash.exe",
    ],
    [
      "the install, when CLAUDE_CODE_GIT_BASH_PATH isn't a bash",
      [GIT_BASH, "D:\\tools\\zsh.exe"],
      { CLAUDE_CODE_GIT_BASH_PATH: "D:\\tools\\zsh.exe" },
      null,
      GIT_BASH,
    ],
    [
      "the bash beside the git on PATH",
      ["D:\\PortableGit\\bin\\bash.exe"],
      {},
      "D:\\PortableGit\\cmd\\git.exe",
      "D:\\PortableGit\\bin\\bash.exe",
    ],
  ])("is Git Bash, as Claude Code finds it: %s", (_, files, env, git, bash) => {
    const shell = shellArgv("pwd; exit 3", "win32", windows(files, env, git));

    expect(shell.argv).toEqual([bash, "-l", "-c", "pwd; exit 3"]);
    // MSYS's login profile would otherwise start it in the home directory, and clear on `exit`.
    expect(shell.env).toEqual({ CHERE_INVOKING: "1", TERM: "dumb" });
  });

  test.each([
    ["PowerShell 7", [PWSH, WINDOWS_POWERSHELL], PWSH],
    ["Windows PowerShell", [WINDOWS_POWERSHELL], WINDOWS_POWERSHELL],
  ])("is %s without Git Bash, the command passed encoded", (_, files, program) => {
    const { argv } = shellArgv("echo 'é' | Out-Host", "win32", windows(files));

    expect(argv.slice(0, -1)).toEqual([
      program,
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(argv.at(-1)!, "base64").toString("utf16le")).toEndWith(
      "\necho 'é' | Out-Host"
    );
  });

  test("is cmd.exe when neither is there", () => {
    const shell = shellArgv("dir", "win32", windows([], { ComSpec: "C:\\Windows\\cmd.exe" }));

    expect(shell.argv).toEqual(["C:\\Windows\\cmd.exe", "/d", "/s", "/c", '"dir"']);
    expect(shell.windowsVerbatimArguments).toBe(true);
  });
});
