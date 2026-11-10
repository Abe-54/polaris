/**
 * The PowerShell an install on a Windows Host runs, as data: staging a private upload
 * directory, writing a file from base64 lines, `polaris.exe install|upgrade`, cleaning up,
 * and the relay `polaris bridge` connects through. Pure, so every script is unit-tested.
 */
import type { BuildFile } from "../builds.ts";
import { currentExe } from "./probe.ts";
import {
  type LineScript,
  psQuote,
  withLines,
  encodedCommand,
  type WindowsShell,
} from "./powershell.ts";

/** A staging directory's name under `%USERPROFILE%\.polaris`: letters, digits and `-` only. */
const checkedDir = (dir: string) => {
  if (!/^[A-Za-z0-9-]+$/.test(dir)) throw new Error(`not a staging directory name: ${dir}`);

  return dir;
};

const checkedName = (name: string) => {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith("."))
    throw new Error(`not a file name: ${name}`);

  return name;
};

const stagingPath = (dir: string) =>
  `(Join-Path $env:USERPROFILE ${psQuote(`.polaris\\${checkedDir(dir)}`)})`;

/**
 * Creates `%USERPROFILE%\.polaris` if missing and `dir` inside it, fresh, with a protected
 * DACL granting only this user, applied as it is created (an elevated SSH logon would
 * otherwise make Administrators its owner with inherited entries).
 */
export const stageScript = (dir: string): string =>
  [
    `$root = Join-Path $env:USERPROFILE '.polaris'`,
    "if (-not (Test-Path -LiteralPath $root)) { [void][IO.Directory]::CreateDirectory($root) }",
    "$item = Get-Item -LiteralPath $root -Force",
    "if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ($root + ' is not a directory') }",
    `$d = ${stagingPath(dir)}`,
    "if (Test-Path -LiteralPath $d) { throw ($d + ' already exists') }",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = New-Object Security.AccessControl.DirectorySecurity",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
    "[void][IO.Directory]::CreateDirectory($d, $acl)",
  ].join("; ");

/** Fails unless `dir` is still a real directory whose only access rule is this user's. */
const stillPrivate = (dir: string) =>
  [
    `$d = ${stagingPath(dir)}`,
    "$item = Get-Item -LiteralPath $d -Force",
    "if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ($d + ' is not a directory') }",
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$rules = @((Get-Acl -LiteralPath $d).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]) -ne $me })",
    "if ($rules.Count -gt 0) { throw ($d + ' is not private to this user') }",
  ].join("; ");

/**
 * Writes `file` into `dir` from base64 lines on stdin, then prints its SHA-256: the file's
 * bytes as they landed on the Host, which the Client compares with the manifest.
 */
export const uploadScript = (dir: string, file: BuildFile): LineScript => {
  const name = checkedName(file.name);

  return {
    begin: [
      stillPrivate(dir),
      `$target = Join-Path $d ${psQuote(name)}`,
      "$out = [IO.File]::Open($target + '.part', 'CreateNew', 'Write', 'None')",
    ].join("; "),
    process: "$bytes = [Convert]::FromBase64String($_); $out.Write($bytes, 0, $bytes.Length)",
    end: [
      "$out.Close()",
      "Move-Item -LiteralPath ($target + '.part') -Destination $target",
      "(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()",
    ].join("; "),
  };
};

export const uploadCommand = (dir: string, file: BuildFile, shell: WindowsShell): string =>
  withLines(uploadScript(dir, file), shell);

/** Runs a `polaris.exe` command, prints what it printed, and exits with its status. */
const runExe = (exe: string, args: ReadonlyArray<string>) =>
  `$exe = ${exe}; & $exe ${args.join(" ")}; exit $LASTEXITCODE`;

/** `--replace-task` when the user took over the sign-in task another home holds. */
const takeOver = (replaceTask: boolean) => (replaceTask ? ["--replace-task"] : []);

/** `<dir>\polaris.exe install --json --sha256 <sha> [--replace-task]`: the first install. */
export const installCommand = (
  dir: string,
  binary: string,
  sha256: string,
  replaceTask = false
): string =>
  encodedCommand(
    runExe(`(Join-Path ${stagingPath(dir)} ${psQuote(checkedName(binary))})`, [
      "install",
      "--json",
      "--sha256",
      psQuote(sha256),
      ...takeOver(replaceTask),
    ])
  );

/** The installed Daemon's `upgrade <dir>\polaris.exe --json --sha256 <sha> [--replace-task]`. */
export const upgradeCommand = (
  dir: string,
  binary: string,
  sha256: string,
  replaceTask = false
): string =>
  encodedCommand(
    [
      `$new = Join-Path ${stagingPath(dir)} ${psQuote(checkedName(binary))}`,
      runExe(currentExe, [
        "upgrade",
        "$new",
        "--json",
        "--sha256",
        psQuote(sha256),
        ...takeOver(replaceTask),
      ]),
    ].join("; ")
  );

/** `polaris.exe install --json` with the installed build: (re)starts the Daemon's task. */
export const startCommand = (replaceTask = false): string =>
  encodedCommand(
    runExe(currentExe, ["install", "--json", ...(replaceTask ? ["--replace-task"] : [])])
  );

/** `polaris.exe install --restart --json`: stops the Daemon on its control pipe, then `schtasks /Run`. */
export const restartCommand = (): string =>
  encodedCommand(runExe(currentExe, ["install", "--restart", "--json"]));

export const cleanUpCommand = (dir: string): string =>
  encodedCommand(
    `Remove-Item -LiteralPath ${stagingPath(dir)} -Recurse -Force -ErrorAction SilentlyContinue`
  );

/**
 * What `polaris bridge` connects through on a Windows Host: base64 lines from stdin, decoded
 * into the bridge's stdin, while its stdout reaches ssh untouched. `--relay $PID` lets the
 * bridge end this PowerShell when it ends; it would otherwise wait for the Client's next line.
 */
export const relayScript: LineScript = {
  begin: [
    `$exe = ${currentExe}`,
    // 127 is what a POSIX shell exits with for a missing command: `polaris-not-installed`.
    "if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { [Console]::Error.WriteLine('polaris: not found: ' + $exe); exit 127 }",
    "$start = New-Object Diagnostics.ProcessStartInfo",
    "$start.FileName = $exe",
    "$start.Arguments = 'bridge --relay ' + $PID",
    "$start.UseShellExecute = $false",
    "$start.RedirectStandardInput = $true",
    "$bridge = [Diagnostics.Process]::Start($start)",
    "$in = $bridge.StandardInput.BaseStream",
  ].join("; "),
  process:
    "$bytes = [Convert]::FromBase64String($_); $in.Write($bytes, 0, $bytes.Length); $in.Flush()",
  end: "$in.Close(); $bridge.WaitForExit(); exit $bridge.ExitCode",
};

export const bridgeCommand = (shell: WindowsShell): string => withLines(relayScript, shell);
