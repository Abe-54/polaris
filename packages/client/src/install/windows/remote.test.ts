/**
 * How the install flow finds a Windows Host, against a fake `Ssh` that answers as a
 * Windows sshd would (its PowerShell has no `sh`, or Git's MINGW one), and how a file
 * travels to one as base64 lines through the real `runCommand`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Result } from "effect";
import { type DaemonReport, RemoteInstallError, TaskConflict } from "../apply.ts";
import type { DaemonBuild } from "../builds.ts";
import { Delivery, InstallPlan } from "../plan.ts";
import { applyPlan, probeHost } from "../remote.ts";
import { Ssh, shellQuote } from "../Ssh.ts";
import { WINDOWS_PROBE_COMMAND } from "./probe.ts";

const WINDOWS_ANSWER =
  "os=windows\r\narch=AMD64\r\nshell=powershell\r\npsversion=5.1.26100.9711\r\n";

/** What PowerShell says when the POSIX probe's `sh` doesn't exist. */
const NO_SH =
  "sh : The term 'sh' is not recognized as the name of a cmdlet, function, script file, or operable program.\r\n";

const fakeSsh = (answer: (command: string) => { code: number; stdout: string; stderr: string }) =>
  Layer.succeed(Ssh, Ssh.of({ exec: (_alias, command) => Effect.succeed(answer(command)) }));

const probeWith = (answer: Parameters<typeof fakeSsh>[0]) =>
  Effect.runPromise(probeHost("pc").pipe(Effect.provide(fakeSsh(answer)), Effect.result));

describe("probeHost on a Windows Host", () => {
  test.each([
    ["PowerShell when there is no sh", "powershell", { code: 1, stdout: "", stderr: NO_SH }],
    [
      "PowerShell when sh is Git for Windows'",
      "powershell",
      { code: 0, stdout: "os=MINGW64_NT-10.0-26200\narch=x86_64\n", stderr: "" },
    ],
    [
      "cmd's PowerShell when cmd has no sh",
      "cmd",
      {
        code: 9009,
        stdout: "",
        stderr: "'sh' is not recognized as an internal or external command,\r\n",
      },
    ],
    [
      "PowerShell when Git's sh can't run the POSIX probe",
      "powershell",
      { code: 1, stdout: "", stderr: "printf: usage: printf [-v var] format [arguments]\n" },
    ],
  ] as const)("asks %s", async (_, shell, posixAnswer) => {
    const result = await probeWith((command) =>
      command === WINDOWS_PROBE_COMMAND
        ? { code: 0, stdout: WINDOWS_ANSWER.replace("powershell", shell), stderr: "" }
        : posixAnswer
    );

    expect(Result.getOrUndefined(result)).toMatchObject({ os: "windows", windowsShell: shell });
  });

  test("a Host that is neither keeps the POSIX probe's error", async () => {
    const result = await probeWith((command) =>
      command === WINDOWS_PROBE_COMMAND
        ? { code: 127, stdout: "", stderr: "sh: powershell: not found" }
        : { code: 2, stdout: "", stderr: "sh: syntax error" }
    );

    expect(Result.isFailure(result) ? result.failure.message : null).toBe(
      "unexpected answer (exit 2): sh: syntax error"
    );
  });
});

const dir = mkdtempSync(join(tmpdir(), "polaris-lines-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("stdin as base64 lines", () => {
  // Ssh.local stands in for the SSH Host through /bin/sh, which Windows lacks (ENG-318).
  test.skipIf(process.platform === "win32")(
    "delivers a file larger than one line, byte for byte",
    async () => {
      const bytes = new Uint8Array(200_000).map((_, i) => (i * 13 + 5) % 256);
      const file = join(dir, "payload.bin");
      writeFileSync(file, bytes);

      const decode = join(dir, "decode.ts");
      writeFileSync(
        decode,
        [
          'import { createHash } from "node:crypto";',
          "const text = await Bun.stdin.text();",
          'const lines = text.split("\\n").filter((line) => line.length > 0);',
          'const bytes = Buffer.concat(lines.map((line) => Buffer.from(line, "base64")));',
          'console.log(lines.length, createHash("sha256").update(bytes).digest("hex"));',
        ].join("\n")
      );

      const result = await Effect.runPromise(
        Ssh.use((ssh) =>
          ssh.exec("local", `${shellQuote(process.execPath)} ${shellQuote(decode)}`, {
            stdinFile: file,
            stdinLines: true,
          })
        ).pipe(Effect.provide(Ssh.local(dir)))
      );

      const [lines, sha256] = result.stdout.trim().split(" ");

      expect(Number(lines)).toBeGreaterThan(1);
      expect(sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  );
});

const SHA = "cd".repeat(32);

const windowsBuild: DaemonBuild = {
  platform: "windows-x64",
  version: "0.2.1",
  sha256: SHA,
  bundled: true,
  archive: null,
  files: [{ name: "polaris.exe", path: "polaris.exe", sha256: SHA, size: 4, executable: true }],
};

/** The script a command line runs: `-EncodedCommand`'s UTF-16LE base64, else the line itself. */
const scriptOf = (line: string) => {
  const encoded = / -EncodedCommand (\S+)$/.exec(line)?.[1];

  return encoded === undefined ? line : Buffer.from(encoded, "base64").toString("utf16le");
};

/** A Windows sshd whose `polaris.exe install|upgrade` answers `report` with exit `code`. */
const windowsHost = (report: DaemonReport, code: number) => {
  const ran: Array<string> = [];

  const layer = Layer.succeed(
    Ssh,
    Ssh.of({
      exec: (_alias, line) =>
        Effect.sync(() => {
          const script = scriptOf(line);
          ran.push(script);

          if (line.startsWith("$input")) return { code: 0, stdout: `${SHA}\r\n`, stderr: "" };

          return / (install|upgrade) /.test(script)
            ? { code, stdout: `${JSON.stringify(report)}\r\n`, stderr: "" }
            : { code: 0, stdout: "", stderr: "" };
        }),
    })
  );

  return { ran, layer };
};

const OTHER_HOME = "C:\\Users\\lucas\\dev\\.polaris";

const CONFLICT = {
  ok: false,
  error: "TaskConflictError",
  message: `the scheduled task dev.lux.polaris.lucas runs the Polaris home ${OTHER_HOME}, not C:\\Users\\lucas\\.polaris; left it alone. Pass --replace-task to take it over.`,
  task: "dev.lux.polaris.lucas",
  otherHome: OTHER_HOME,
};

const plans = {
  install: InstallPlan.Install({
    build: windowsBuild,
    delivery: Delivery.Upload(),
    windowsShell: "powershell",
  }),
  upgrade: InstallPlan.Upgrade({
    from: "0.2.0",
    build: windowsBuild,
    delivery: Delivery.Upload(),
    windowsShell: "powershell",
  }),
};

describe("a sign-in task another Polaris home holds", () => {
  test.each(["install", "upgrade"] as const)(
    "%s fails as a TaskConflict naming the task and that home",
    async (kind) => {
      const { layer } = windowsHost(CONFLICT, 3);

      const result = await Effect.runPromise(
        applyPlan("pc", plans[kind]).pipe(Effect.provide(layer), Effect.flip)
      );

      expect(result).toBeInstanceOf(TaskConflict);
      expect(result).toMatchObject({
        alias: "pc",
        step: kind,
        task: "dev.lux.polaris.lucas",
        otherHome: OTHER_HOME,
      });
    }
  );

  test.each(["install", "upgrade"] as const)(
    "%s passes --replace-task only when told to take it over",
    async (kind) => {
      const commands = async (replaceTask: boolean) => {
        const { ran, layer } = windowsHost({ ok: true, notes: [] }, 0);
        await Effect.runPromise(
          applyPlan("pc", plans[kind], { replaceTask }).pipe(Effect.provide(layer))
        );

        return ran.filter((script) => / (install|upgrade) /.test(script));
      };

      const [plain] = await commands(false);
      const [takeOver] = await commands(true);

      expect(plain).not.toContain("--replace-task");
      expect(takeOver).toContain(`${kind} `);
      expect(takeOver).toContain("--replace-task");
    }
  );

  test("any other failed report stays a RemoteInstallError", async () => {
    const { layer } = windowsHost({ ok: false, error: "InstallError", message: "boom" }, 1);

    const result = await Effect.runPromise(
      applyPlan("pc", plans.install).pipe(Effect.provide(layer), Effect.flip)
    );

    expect(result).toBeInstanceOf(RemoteInstallError);
    expect(result.message).toBe("boom");
  });
});
