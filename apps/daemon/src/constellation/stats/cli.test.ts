import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConstellationStats } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { EventStore } from "../../store/EventStore.ts";
import { CID } from "../../engine/constellation.testing.ts";
import { seedStats } from "./store.testing.ts";
import { localEndpoint } from "@polaris/protocol/endpoint";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

test("the real CLI reads Stats over RPC from an isolated Daemon and emits decodable JSON", async () => {
  const home = newTempDir("polaris-stats-cli-", { short: true });
  const main = resolve(import.meta.dir, "../../main.ts");

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, "codex"),
    CLAUDE_CONFIG_DIR: join(home, "claude"),
    POLARIS_HOME: home,
    POLARIS_HOST_SOCKET: localEndpoint(home),
    POLARIS_BENCH_HARNESS: "1",
    POLARIS_SESSION_ID: undefined,
    POLARIS_BINARY: undefined,
  };

  await Effect.runPromise(
    seedStats.pipe(Effect.provide(EventStore.layerSqlite(join(home, "state.sqlite"))))
  );

  const daemon = Bun.spawn([process.execPath, main, "serve", "--foreground"], {
    env,
    stdout: "pipe",
    stderr: "ignore",
  });

  try {
    // A Windows pipe has no file to wait for, and opening one to look takes a connection.
    const reader = daemon.stdout.getReader();
    let logs = "";

    while (!logs.includes("Daemon listening on")) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`Daemon stopped: ${logs}`);
      logs += new TextDecoder().decode(chunk.value);
    }

    reader.releaseLock();

    const child = Bun.spawn([process.execPath, main, "constellation", "stats", "c1", "--json"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(errors).toBe("");
    const stats = Schema.decodeUnknownSync(Schema.fromJsonString(ConstellationStats))(output);
    expect(stats.constellationId).toBe(CID);
    expect(stats.lead.wakeups).toBe(2);
    expect(stats.usage.total.tokens.input).toBe(0);
    expect(stats.workers.attempts).toHaveLength(2);
    expect(output).toContain('"api-equivalent-estimate"');
    expect(output).toContain('"staleMs": 0');
    expect(existsSync(join(home, "usage.sqlite"))).toBe(true);
  } finally {
    daemon.kill("SIGTERM");
    await daemon.exited;
    removeTempDir(home);
  }
}, 20000);
