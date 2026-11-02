import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalog } from "./index";
import { probeDeveloperShellCheck, shellCheckServerSettings } from "./developer-shellcheck";
import { posixTest } from "../../platform/testing.ts";

const posixTools = posixTest(
  "the synthetic ShellCheck is a POSIX sh script with process groups and sessions (ENG-296)"
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (body: string) => {
  const root = await mkdtemp(join(tmpdir(), "polaris-synthetic-shellcheck-"));
  roots.push(root);
  const path = join(root, "shellcheck");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o700);

  return { path, root, input: { trusted: true, configuredPath: path, searchPath: [], cwd: root } };
};

test("current catalog requires Host ShellCheck and manages shfmt while ShellCheck downloads remain blocked", () => {
  const bash = catalog.integrations.find((entry) => entry.id === "bash")!;
  expect(bash.companions).toEqual(["shfmt"]);
  expect(bash.offered).toBe(true);

  const requirement = catalog.tools
    .find((entry) => entry.id === "bash-language-server")!
    .requirements.find((entry) => entry.id === "shellcheck")!;

  expect(requirement.required).toBe(true);
  expect(requirement.installCommands?.map((entry) => entry.command)).toEqual([
    "brew install shellcheck",
    "sudo apt install shellcheck",
  ]);
  expect(
    bash.developerCompanions?.some((companion) => companion.id === "shellcheck") ?? false
  ).toBe(false);
  expect(catalog.tools.find((entry) => entry.id === "shellcheck")?.disposition).toBe("offered");
  expect(
    catalog.tools
      .find((entry) => entry.id === "shellcheck")
      ?.artifacts.every((artifact) => artifact.audit === "pending")
  ).toBe(true);
});

test("untrusted configured executables never run and Bash automatic discovery stays disabled", async () => {
  const f = await fixture('touch invoked; printf "ShellCheck\\nversion: 0.11.0\\n"');
  const fact = await probeDeveloperShellCheck({ ...f.input, trusted: false });
  expect(fact.status).toBe("trust-required");
  expect(await Bun.file(join(f.root, "invoked")).exists()).toBe(false);
  expect(shellCheckServerSettings(fact)).toEqual({ shellcheckPath: "" });
});

posixTools(
  "synthetic version fixture supports configured and explicit Host PATH discovery",
  async () => {
    const f = await fixture('printf "ShellCheck\\nversion: 0.11.0\\n"');

    for (const configuredPath of [f.path, null]) {
      const fact = await probeDeveloperShellCheck({
        ...f.input,
        configuredPath,
        searchPath: [".", f.root],
      });

      expect(fact.status).toBe("available");
      expect(fact.version).toBe("0.11.0");
      expect(shellCheckServerSettings(fact).shellcheckPath).toBe(fact.executable);
    }
  }
);

test("missing or invalid configured paths do not fall back to another executable", async () => {
  const f = await fixture('printf "ShellCheck\\nversion: 0.11.0\\n"');

  for (const configuredPath of ["shellcheck", join(f.root, "missing")]) {
    const fact = await probeDeveloperShellCheck({
      ...f.input,
      configuredPath,
      searchPath: [f.root],
    });

    expect(fact.status).toBe("missing-prerequisite");
    expect(fact.shellcheckDiagnostics).toBe(false);
  }
});

test("synthetic stale, malformed, failed and oversized output cannot enable diagnostics", async () => {
  for (const body of [
    'printf "ShellCheck\\nversion: 0.10.0\\n"',
    'printf "version: 0.11.0\\n"',
    "exit 1",
    'while :; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; done',
  ]) {
    const f = await fixture(body);
    expect((await probeDeveloperShellCheck(f.input)).status).toBe("probe-failed");
  }
});

posixTools(
  "synthetic hung process trees are bounded and reaped",
  async () => {
    const f = await fixture("/bin/sleep 30 &\necho $! > child.pid\nwait");
    const start = Date.now();
    expect((await probeDeveloperShellCheck(f.input)).status).toBe("probe-failed");
    expect(Date.now() - start).toBeLessThan(4000);
    const pid = Number(await readFile(join(f.root, "child.pid"), "utf8"));

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }

      await Bun.sleep(10);
    }

    expect(() => process.kill(pid, 0)).toThrow();
  },
  6000
);

// The fixture runs with no PATH, so its shebang names this machine's python3 outright.
const PYTHON = Bun.which("python3") ?? "/usr/bin/python3";

posixTools(
  "synthetic new-session held pipes fail closed; fixture owner reaps escaped descendants",
  async () => {
    for (const ending of [
      "print('ShellCheck\\nversion: 0.11.0', flush=True); os._exit(0)",
      "os._exit(1)",
      "print('x' * 8192, flush=True); time.sleep(30)",
      "time.sleep(30)",
    ]) {
      const f = await fixture("");
      await writeFile(
        f.path,
        `#!${PYTHON}
import os,time
pid=os.fork()
if pid==0:
 os.setsid()
 with open('escaped.pid','w') as receipt: receipt.write(str(os.getpid()))
 time.sleep(30)
 os._exit(0)
while not os.path.exists('escaped.pid'): time.sleep(0.01)
${ending}
`
      );
      let pid: number | undefined;
      let elapsedMs = 0;

      try {
        const start = Date.now();
        const fact = await probeDeveloperShellCheck(f.input);
        elapsedMs = Date.now() - start;
        expect(Date.now() - start).toBeLessThan(3000);
        expect(fact.status).toBe("probe-failed");
        expect(fact.shellcheckDiagnostics).toBe(false);
        expect(shellCheckServerSettings(fact)).toEqual({ shellcheckPath: "" });
        pid = Number(await readFile(join(f.root, "escaped.pid"), "utf8"));
        expect(() => process.kill(pid!, 0)).not.toThrow();
      } finally {
        pid ??= Number(await readFile(join(f.root, "escaped.pid"), "utf8"));
        process.kill(pid, "SIGKILL");

        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }

          await Bun.sleep(10);
        }

        expect(() => process.kill(pid!, 0)).toThrow();
        console.log(
          JSON.stringify({
            topology: "synthetic-setsid-held-pipe",
            ending,
            elapsedMs,
            status: "probe-failed",
            escapedChildAliveAfterProbe: true,
            fixtureOwnerCleanupVerified: true,
          })
        );
      }
    }
  },
  15000
);
