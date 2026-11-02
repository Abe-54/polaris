/**
 * `polaris bridge` when no Daemon answers: on a Host with the fallback
 * supervisor it starts `~/.polaris/bin/polaris-supervise`, waits for the
 * socket and tries once more before exiting 69.
 *
 * The bridge runs as its own process (fixtures/bridge.ts): under `bun test`,
 * a failed `node:net` connect to a Unix socket fails the test even when the
 * error is handled. The supervisor is a stand-in script that starts
 * fixtures/echo-daemon.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_EXIT_NO_DAEMON } from "@polaris/protocol";
import { posixTest } from "../platform/testing.ts";
import { newTempDir, removeTempDirSettled } from "../platform/tempDir.testing.ts";

const supervisorTest = posixTest(
  "the fallback supervisor is a /bin/sh script; Windows has the logon task (ADR 0060)"
);

const BRIDGE = join(import.meta.dir, "fixtures", "bridge.ts");

const ECHO = join(import.meta.dir, "fixtures", "echo-daemon.ts");

const homes: Array<string> = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    const pidFile = join(home, "echo.pid");

    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf8").trim()));
      } catch {}
    }

    await removeTempDirSettled(home);
  }
});

const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A POLARIS_HOME whose supervisor (if `script`) runs `script`, logging each start. */
const makeHome = (script: ((home: string) => string) | null) => {
  const home = newTempDir("polaris-bridge-");
  homes.push(home);

  if (script !== null) {
    mkdirSync(join(home, "bin"));
    writeFileSync(
      join(home, "bin", "polaris-supervise"),
      `#!/bin/sh\necho start >> ${q(join(home, "starts.log"))}\n${script(home)}\n`,
      { mode: 0o755 }
    );
  }

  return home;
};

const starts = (home: string) => {
  const log = join(home, "starts.log");

  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
};

const bridge = async (home: string, input: string, waitMs: number, systemdUnit?: string) => {
  const unit = systemdUnit === undefined ? [] : [systemdUnit];

  const child = Bun.spawn([process.execPath, BRIDGE, String(waitMs), ...unit], {
    env: { ...process.env, POLARIS_HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  await child.stdin.write(input);
  await child.stdin.flush();

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { code, stdout, stderr };
};

describe("polaris bridge without a Daemon", () => {
  supervisorTest("starts the fallback supervisor, waits for the socket and connects", async () => {
    const home = makeHome(
      (dir) =>
        `POLARIS_HOME=${q(dir)} nohup ${q(process.execPath)} ${q(ECHO)} >/dev/null 2>&1 &\necho $! > ${q(join(dir, "echo.pid"))}`
    );

    const result = await bridge(home, "hello\n", 5000);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
    expect(starts(home)).toBe(1);
  });

  supervisorTest("exits 69 when the supervisor does not bring a Daemon up in time", async () => {
    const home = makeHome(() => "exit 0");
    const at = Date.now();
    const result = await bridge(home, "hello\n", 300);
    expect(result.code).toBe(BRIDGE_EXIT_NO_DAEMON);
    expect(result.stderr).toContain("no Daemon is running");
    expect(starts(home)).toBe(1);
    expect(Date.now() - at).toBeGreaterThanOrEqual(300);
  });

  test("exits 69 at once on a Host without the fallback supervisor or a systemd unit", async () => {
    const home = makeHome(null);
    const at = Date.now();
    const result = await bridge(home, "hello\n", 5000, join(home, "polaris.service"));
    expect(result.code).toBe(BRIDGE_EXIT_NO_DAEMON);
    expect(result.stderr).toContain("no Daemon is running");
    expect(Date.now() - at).toBeLessThan(4000);
  });

  test("under systemd, waits for the Daemon systemd is still starting (a WSL distro's boot)", async () => {
    const home = makeHome(null);
    const unit = join(home, "polaris.service");
    writeFileSync(unit, "[Service]\n");

    const late = setTimeout(() => {
      const daemon = Bun.spawn([process.execPath, ECHO], {
        env: { ...process.env, POLARIS_HOME: home },
        stdio: ["ignore", "ignore", "ignore"],
      });

      writeFileSync(join(home, "echo.pid"), String(daemon.pid));
    }, 300);

    const result = await bridge(home, "hello\n", 5000, unit).finally(() => clearTimeout(late));
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });
});
