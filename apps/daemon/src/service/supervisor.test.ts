import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
/**
 * The fallback supervisor script (templates.ts `supervisorScript`), run for
 * real with /bin/sh against a stand-in `polaris serve`.
 */
import { afterEach, describe, expect } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shQuote, supervisorScript } from "./templates.ts";
import { posixTest } from "../platform/testing.ts";

const shTest = posixTest(
  "the fallback supervisor is a /bin/sh script; Windows has the logon task (ADR 0060)"
);

let root: string;

/** The pid a stand-in wrote to `file`, once the whole line is there: an empty read would be pid 0. */
const readPid = (file: string): number | null => {
  try {
    const text = readFileSync(file, "utf8");

    return /^[1-9]\d*\n$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
};

afterEach(() => {
  // Only the supervisor runs make a root; on Windows they skip.
  if (root === undefined) return;

  // Stop anything a test left running.
  for (const file of ["supervisor.pid", "daemon.pid"]) {
    try {
      const pid = readPid(join(root, file));

      if (pid !== null) process.kill(pid, "SIGKILL");
    } catch {}
  }

  removeTempDir(root);
});

const waitFor = async (condition: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/**
 * A home with a fake `polaris` that logs each start to `starts` and then
 * behaves as `behaviour` says (per start number): "crash" exits 1, "busy"
 * exits 75 (another Daemon runs), anything else stays up.
 */
const setup = (behaviour: string) => {
  root = newTempDir("polaris-sup-");
  const program = join(root, "polaris");
  writeFileSync(
    program,
    `#!/bin/sh
echo $$ >>${shQuote(join(root, "starts"))}
echo $$ >${shQuote(join(root, "daemon.pid"))}
echo $PPID >${shQuote(join(root, "parent.pid"))}
n=$(wc -l <${shQuote(join(root, "starts"))} | tr -d ' ')
case "$(echo ${shQuote(behaviour)} | cut -d, -f"$n")" in
  crash) exit 1 ;;
  busy) exit 75 ;;
  *) exec sleep 300 ;;
esac
`
  );
  chmodSync(program, 0o755);
  const script = join(root, "polaris-supervise");
  writeFileSync(
    script,
    supervisorScript({
      program,
      args: ["serve"],
      home: root,
      logDir: join(root, "logs"),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    })
  );
  chmodSync(script, 0o755);

  // Only whole lines: a start being written is not one yet.
  const starts = () =>
    existsSync(join(root, "starts"))
      ? readFileSync(join(root, "starts"), "utf8").split("\n").slice(0, -1).map(Number)
      : [];

  const supervisorPid = () => readPid(join(root, "supervisor.pid"));

  const launch = () => Bun.spawnSync([script]).exitCode;

  return { program, script, starts, supervisorPid, launch };
};

describe("fallback supervisor", () => {
  shTest(
    "detaches, runs the Daemon, and restarts it after a crash",
    async () => {
      const sup = setup("crash,up");
      expect(sup.launch()).toBe(0); // returns at once
      await waitFor(() => sup.starts().length >= 2);
      const [, daemon] = sup.starts();
      expect(alive(daemon!)).toBe(true);
      // A second launch (cron, profile, reinstall) is a no-op: still one Daemon.
      expect(sup.launch()).toBe(0);
      await Bun.sleep(300);
      expect(sup.starts()).toHaveLength(2);
      expect(readFileSync(join(root, "logs", "supervisor.log"), "utf8")).toContain(
        "polaris serve exited 1"
      );
    },
    20_000
  );

  shTest(
    "SIGTERM stops the supervisor and its Daemon",
    async () => {
      const sup = setup("up");
      sup.launch();
      await waitFor(() => sup.starts().length === 1 && sup.supervisorPid() !== null);
      const supervisor = sup.supervisorPid()!;
      const daemon = sup.starts()[0]!;
      process.kill(supervisor, "SIGTERM");
      await waitFor(() => !alive(supervisor) && !alive(daemon));
      expect(existsSync(join(root, "supervisor.pid"))).toBe(false);
    },
    20_000
  );

  shTest(
    "gives up when another Daemon already holds the lock (exit 75)",
    async () => {
      const sup = setup("busy");
      sup.launch();
      await waitFor(() => readPid(join(root, "parent.pid")) !== null);
      // Once the supervisor that ran it has exited, nothing is left to restart it.
      const supervisor = readPid(join(root, "parent.pid"))!;
      await waitFor(() => !alive(supervisor));
      expect(existsSync(join(root, "supervisor.pid"))).toBe(false);
      expect(sup.starts()).toHaveLength(1);
    },
    20_000
  );
});
