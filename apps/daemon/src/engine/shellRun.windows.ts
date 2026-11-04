/**
 * The shell a user's shell command (`RunShellCommand`) runs in on a Windows Host: Git Bash,
 * found the way Claude Code finds it for its own Bash tool and `!` mode, then PowerShell as
 * Claude Code's PowerShell tool finds it, then cmd.exe. See docs/adr/0061-windows-process-trees.md.
 */
import { win32 } from "node:path";
import {
  encodePowershell,
  envValue,
  type ShellCommand,
  shellCommand,
} from "../platform/processes.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** What the lookup reads: the command's environment, the file system, and its PATH. */
export interface WindowsShellSources {
  readonly env: Env;
  readonly exists: (path: string) => boolean;
  /** The absolute path of the Git on the command's PATH, or null. */
  readonly gitOnPath: () => string | null;
}

/** The names Claude Code accepts in `CLAUDE_CODE_GIT_BASH_PATH`. */
const BASH_NAMES = ["bash.exe", "sh.exe", "bash", "sh"];

const programFiles = (env: Env) => envValue(env, "ProgramFiles") ?? "C:\\Program Files";

/**
 * Git Bash: `CLAUDE_CODE_GIT_BASH_PATH` when it names a bash that exists, then Git for Windows'
 * install directories, then the `bin\bash.exe` beside the `git` on PATH (`Git\cmd\git.exe`).
 */
export const gitBash = ({ env, exists, gitOnPath }: WindowsShellSources): string | null => {
  const configured = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH");

  if (
    configured !== undefined &&
    BASH_NAMES.includes(win32.basename(configured).toLowerCase()) &&
    exists(configured)
  )
    return configured;

  const installed = [
    win32.join(programFiles(env), "Git", "bin", "bash.exe"),
    win32.join(
      envValue(env, "ProgramFiles(x86)") ?? "C:\\Program Files (x86)",
      "Git",
      "bin",
      "bash.exe"
    ),
  ].find(exists);

  if (installed !== undefined) return installed;
  const onPath = gitOnPath();
  const beside = onPath === null ? null : win32.join(onPath, "..", "..", "bin", "bash.exe");

  return beside !== null && exists(beside) ? beside : null;
};

/** PowerShell 7, its preview, then Windows PowerShell, each at its install path. */
const powershell = ({ env, exists }: WindowsShellSources): string | null =>
  [
    win32.join(programFiles(env), "PowerShell", "7", "pwsh.exe"),
    win32.join(programFiles(env), "PowerShell", "7-preview", "pwsh.exe"),
    win32.join(
      envValue(env, "SystemRoot") ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    ),
  ].find(exists) ?? null;

/** Output in UTF-8 (the pipe is read as UTF-8), where the language mode allows it. */
const UTF8_OUTPUT =
  "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {} }";

/**
 * How `command` runs on Windows. Git Bash runs it as `-l -c` (Claude Code's own flags), and
 * `CHERE_INVOKING` keeps MSYS's login profile from moving it to the home directory. Its output is
 * a pipe, so `TERM=dumb`: Git's bash.bash_logout would otherwise append a screen clear on `exit`.
 */
export const windowsShellArgv = (
  command: string,
  sources: WindowsShellSources
): ShellCommand & { readonly env: Env } => {
  const bash = gitBash(sources);

  if (bash !== null)
    return {
      argv: [bash, "-l", "-c", command],
      windowsVerbatimArguments: false,
      env: { CHERE_INVOKING: "1", TERM: "dumb" },
    };

  const pwsh = powershell(sources);

  if (pwsh !== null)
    return {
      argv: [
        pwsh,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowershell(`${UTF8_OUTPUT}\n${command}`),
      ],
      windowsVerbatimArguments: false,
      env: {},
    };

  return { ...shellCommand(command, "win32", sources.env), env: {} };
};
