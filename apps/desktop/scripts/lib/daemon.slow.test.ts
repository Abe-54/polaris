import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { testEnv } from "./daemon.ts";

test("smoke environment excludes overridden handoff and preserves fixture settings", () => {
  const extra = { POLARIS_HANDOFF: "override", PATH: "/fixture/bin", HOME: "/fixture/user" };
  const env = testEnv("/fixture/daemon", true, undefined, extra);

  expect(env.POLARIS_HANDOFF).toBeUndefined();
  expect(env.POLARIS_HOME).toBe("/fixture/daemon");
  expect(env.POLARIS_BENCH_HARNESS).toBe("1");
  expect(env.HOME).toBe("/fixture/user");
  expect(env.PATH).toBe("/fixture/bin");
  expect(extra.POLARIS_HANDOFF).toBe("override");
});

test.each(["inherited", "override"])(
  "a fresh source Daemon excludes %s upgrade hand-off",
  (mode) => {
    // A short root: the Daemon's socket path must stay under ~104 bytes (macOS's TMPDIR is long).
    const home = mkdtempSync(join(realpathSync("/tmp"), "polaris-smoke-handoff-"));

    try {
      const result = spawnSync(
        "node",
        [join(import.meta.dir, "fixtures/daemon-start.ts"), home, mode],
        {
          env: {
            ...process.env,
            POLARIS_HANDOFF: JSON.stringify({
              listenerFd: 999_999,
              fds: {},
              children: {},
              fromVersion: "0.0.0-test",
              requestId: null,
            }),
          },
          encoding: "utf8",
          timeout: 25_000,
        }
      );

      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
  30_000
);
