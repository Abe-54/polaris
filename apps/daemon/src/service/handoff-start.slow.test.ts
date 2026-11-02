import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";
import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { posixTest } from "../platform/testing.ts";

const handoffTest = posixTest("the execve hand-off and its descriptors (ADR 0060)");

const fixture = join(import.meta.dir, "fixtures/handoff-start.ts");

test.skipIf(process.platform !== "linux")(
  "accepts Linux startup flags on inherited sockets",
  () => {
    const home = newTempDir("phf-", { short: true });

    try {
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "fixtures/handoff-flags.ts")],
        {
          env: { ...process.env, POLARIS_HOME: home },
          encoding: "utf8",
          timeout: 20000,
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PASS:");
    } finally {
      removeTempDir(home);
    }
  }
);

handoffTest(
  "the full source Daemon cold-starts under an inherited invalid listener",
  async () => {
    const home = newTempDir("phm-", { short: true });

    const daemon = spawn(
      process.execPath,
      [join(import.meta.dir, "../main.ts"), "serve", "--foreground"],
      {
        env: {
          ...process.env,
          HOME: home,
          POLARIS_HOME: home,
          POLARIS_BENCH_HARNESS: "1",
          POLARIS_HANDOFF: JSON.stringify({
            listenerFd: 999_999,
            fds: {},
            children: {},
            fromVersion: "0.0.0-test",
            requestId: null,
          }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    const exited = once(daemon, "exit");
    let logs = "";

    daemon.stdout.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });
    daemon.stderr.on("data", (chunk: Buffer) => {
      logs += chunk.toString();
    });

    const connected = () =>
      new Promise<boolean>((resolve) => {
        const path = join(home, "daemon.sock");

        if (!existsSync(path)) {
          resolve(false);

          return;
        }

        const socket = connect(path);

        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      });

    try {
      const deadline = Date.now() + 15_000;

      while (!(await connected())) {
        if (daemon.exitCode !== null || Date.now() > deadline) throw new Error(logs);
        await sleep(50);
      }

      await sleep(600);
      expect(await connected()).toBe(true);
      expect(daemon.exitCode).toBeNull();
      expect(logs).toContain("ignoring an invalid upgrade hand-off");
    } finally {
      daemon.kill("SIGTERM");
      const killed = setTimeout(() => daemon.kill("SIGKILL"), 3000);

      await exited;
      clearTimeout(killed);
      removeTempDir(home);
    }
  },
  25_000
);

for (const mode of [
  "closed",
  "stdio",
  "file",
  "connected",
  "foreign",
  "children",
  "cloexec",
  "file-child",
]) {
  handoffTest(
    `ignores a ${mode} hand-off without closing unrelated descriptors`,
    () => {
      const home = newTempDir("phs-", { short: true });

      try {
        const result = spawnSync(process.execPath, [fixture, mode], {
          env: { ...process.env, POLARIS_HOME: home, POLARIS_HANDOFF: "" },
          encoding: "utf8",
          timeout: 20_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        removeTempDir(home);
      }
    },
    25_000
  );
}
