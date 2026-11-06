import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyExit } from "../../failures.ts";
import type { BuildFile } from "../builds.ts";
import {
  encodedCommand,
  encodeLines,
  LINE_BYTES,
  psQuote,
  stripClixml,
  withLines,
} from "./powershell.ts";
import { isWindowsUname, parseWindowsProbe, WINDOWS_PROBE_COMMAND } from "./probe.ts";
import {
  bridgeCommand,
  cleanUpCommand,
  installCommand,
  stageScript,
  startCommand,
  upgradeCommand,
  uploadCommand,
} from "./scripts.ts";

/** What a nested Windows PowerShell 5.1 wrote on stderr for a `Write-Error`, as captured on Windows 11. */
const CLIXML_ERROR = [
  "#< CLIXML",
  `<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><S S="Error">Write-Error "boom: C:\\Users\\x &lt;y&gt; &amp; 'z'"_x000D__x000A_</S><S S="Error"> : boom: C:\\Users\\x &lt;y&gt; &amp; 'z'_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>`,
].join("\r\n");

const PROGRESS_ONLY = `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>`;

describe("stderr from a Windows PowerShell", () => {
  test("keeps CLIXML's error lines, decoded, and drops progress", () => {
    expect(stripClixml(CLIXML_ERROR)).toBe(
      [
        `Write-Error "boom: C:\\Users\\x <y> & 'z'"`,
        ` : boom: C:\\Users\\x <y> & 'z'`,
        "    + FullyQualifiedErrorId : Microsoft.PowerShell.Commands.WriteErrorException",
      ].join("\n")
    );
    expect(stripClixml(PROGRESS_ONLY)).toBe("");
  });

  test("leaves plain stderr alone", () => {
    const posix = "sh: 1: polaris: not found\n";

    expect(stripClixml(posix)).toBe(posix);
  });

  test("a relay that finds no Daemon binary reads as Polaris not installed, CLIXML or not", () => {
    const plain = "polaris: not found: C:\\Users\\l\\.polaris\\bin\\current\\polaris.exe\r\n";

    expect(classifyExit({ code: 127, signal: null, stderr: plain }).reason).toBe(
      "polaris-not-installed"
    );
    expect(
      classifyExit({ code: 127, signal: null, stderr: `${PROGRESS_ONLY}${plain}` }).reason
    ).toBe("polaris-not-installed");
  });

  test("a bridge that refused another account's pipe needs the user", () => {
    const failure = classifyExit({
      code: 77,
      signal: null,
      stderr:
        "polaris bridge: \\\\.\\pipe\\polaris-ab is owned by S-1-5-32-544, not this user (S-1-5-21-1-2-3-1001): another account holds the Daemon's pipe name; nothing was sent\n",
    });

    expect([failure.kind, failure.reason]).toEqual(["needs-attention", "daemon-untrusted"]);
  });
});

describe("base64 lines", () => {
  test("carry every byte, in lines no longer than the relay reads at once", () => {
    const bytes = new Uint8Array(LINE_BYTES * 2 + 7).map((_, i) => (i * 31) % 256);
    const lines = encodeLines(bytes).split("\n");

    expect(lines.at(-1)).toBe("");
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.concat(lines.map((line) => Buffer.from(line, "base64")))).toEqual(
      Buffer.from(bytes)
    );
  });
});

const file: BuildFile = {
  name: "polaris.exe",
  path: "/dist/windows-x64/polaris.exe",
  sha256: "e5e414cf1ab95ddc017aebff10e88f9e2bfab810364fa485d0d7b1b0c5e96ed5",
  size: 141_327_872,
  executable: true,
};

const commandsFor = (shell: "powershell" | "cmd") => ({
  probe: WINDOWS_PROBE_COMMAND,
  stage: encodedCommand(stageScript("upload-0123456789ab")),
  upload: uploadCommand("upload-0123456789ab", file, shell),
  install: installCommand("upload-0123456789ab", file.name, file.sha256),
  upgrade: upgradeCommand("upload-0123456789ab", file.name, file.sha256),
  start: startCommand(),
  cleanUp: cleanUpCommand("upload-0123456789ab"),
  bridge: bridgeCommand(shell),
});

describe("command lines", () => {
  // cmd.exe refuses a line over 8191 characters; CreateProcess one over 32767.
  test.each([
    ["cmd", 8191],
    ["powershell", 32_767],
  ] as const)("fit what %s accepts", (shell, limit) => {
    for (const [name, line] of Object.entries(commandsFor(shell)))
      expect({ name, fits: line.length <= limit }).toEqual({ name, fits: true });
  });

  test("never put a double quote in a line sshd hands to PowerShell's -c", () => {
    for (const line of Object.values(commandsFor("powershell"))) expect(line).not.toContain('"');
  });

  test("refuse a staging directory or file name that could leave `.polaris`", () => {
    expect(() => stageScript("..\\x")).toThrow();
    expect(() => uploadCommand("upload-1", { ...file, name: "..\\polaris.exe" }, "cmd")).toThrow();
  });
});

describe("the Windows probe", () => {
  test("recognises the unames of Git for Windows' sh, not Linux or macOS", () => {
    expect(isWindowsUname("MINGW64_NT-10.0-26200")).toBe(true);
    expect(isWindowsUname("MSYS_NT-10.0")).toBe(true);
    expect(isWindowsUname("Linux")).toBe(false);
    expect(isWindowsUname("Darwin")).toBe(false);
  });

  test("reads the shell, the architecture and the installed Daemon", () => {
    const stdout =
      "os=windows\r\narch=AMD64\r\nshell=pwsh\r\npsversion=5.1.26100.9711\r\ninstalled=polaris 0.2.0 windows-x64\r\n";

    expect(parseWindowsProbe(stdout)).toEqual({
      os: "windows",
      arch: "AMD64",
      installed: { version: "0.2.0", platform: "windows-x64" },
      tools: { fetch: null, tar: false, sha256: true },
      windowsShell: "powershell",
    });
    expect(parseWindowsProbe("os=windows\narch=AMD64\nshell=cmd\n")?.windowsShell).toBe("cmd");
  });

  test("names a DefaultShell it can't drive", () => {
    expect(parseWindowsProbe("os=windows\narch=AMD64\nshell=bash\n")?.unsupportedShell).toBe(
      "bash"
    );
    expect(parseWindowsProbe("os=Linux\narch=x86_64\n")).toBeNull();
  });
});

const onWindows = process.platform === "win32";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Runs `line` as sshd would under `shell`, with USERPROFILE at a fresh "Host" profile. */
const run = (shell: "powershell" | "cmd", line: string, home: string, stdin = "") => {
  const argv =
    shell === "cmd"
      ? ["cmd.exe", "/d", "/c", line]
      : ["powershell.exe", "-NoLogo", "-NoProfile", "-c", line];

  // sshd starts a fresh logon: PowerShell 7's PSModulePath (a pwsh CI step) breaks 5.1's Get-Acl.
  const { PSModulePath: _inherited, ...env } = process.env;

  const proc = Bun.spawnSync(argv, {
    env: { ...env, USERPROFILE: home },
    stdin: Buffer.from(stdin),
  });

  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};

// Each PowerShell start costs about half a second, the first one several.
const SLOW = { timeout: 30_000 };

describe.skipIf(!onWindows)("on Windows (powershell.exe and cmd.exe as sshd runs them)", () => {
  test.each(["powershell", "cmd"] as const)(
    "under %s, an upload lands byte for byte and prints its SHA-256",
    (shell) => {
      const home = mkdtempSync(join(tmpdir(), "polaris-win-host-"));
      homes.push(home);
      const bytes = new Uint8Array(300_000).map((_, i) => (i * 7 + 3) % 256);
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      expect(run(shell, encodedCommand(stageScript("upload-test")), home).code).toBe(0);

      const uploaded = run(
        shell,
        uploadCommand("upload-test", { ...file, sha256 }, shell),
        home,
        encodeLines(bytes)
      );

      expect(uploaded.stdout.trim()).toBe(sha256);
      expect(readFileSync(join(home, ".polaris", "upload-test", "polaris.exe"))).toEqual(
        Buffer.from(bytes)
      );
    },
    SLOW
  );

  test(
    "a staging directory that already exists is refused, in one plain line",
    () => {
      const home = mkdtempSync(join(tmpdir(), "polaris-win-host-"));
      homes.push(home);
      const line = encodedCommand(stageScript("upload-twice"));

      expect(run("cmd", line, home).code).toBe(0);
      const again = run("cmd", line, home);

      expect(again.code).toBe(1);
      expect(stripClixml(again.stderr).trim()).toMatch(/^polaris: .*upload-twice already exists$/);
    },
    SLOW
  );

  test(
    "the relay without an installed Daemon exits as a missing command",
    () => {
      const home = mkdtempSync(join(tmpdir(), "polaris-win-host-"));
      homes.push(home);
      const result = run("powershell", bridgeCommand("powershell"), home);

      expect(result.code).toBe(127);
      expect(classifyExit({ code: result.code, signal: null, stderr: result.stderr }).reason).toBe(
        "polaris-not-installed"
      );
    },
    SLOW
  );

  test(
    "a PowerShell string keeps its quote",
    () => {
      const home = mkdtempSync(join(tmpdir(), "polaris-win-host-"));
      homes.push(home);

      expect(
        run("cmd", encodedCommand(`Write-Output ${psQuote("O'Brien")}`), home).stdout.trim()
      ).toBe("O'Brien");
    },
    SLOW
  );

  test(
    "withLines feeds every line, in order, under both shells",
    () => {
      const home = mkdtempSync(join(tmpdir(), "polaris-win-host-"));
      homes.push(home);
      const script = { begin: "$n = 0", process: "$n += [int]$_", end: "Write-Output $n" };

      for (const shell of ["powershell", "cmd"] as const)
        expect(run(shell, withLines(script, shell), home, "1\n2\n39\n").stdout.trim()).toBe("42");
    },
    SLOW
  );
});
