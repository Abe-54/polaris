import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect, Logger } from "effect";
import { makeCodexDriver } from "./CodexDriver.ts";
import { startFakeAppServer } from "./testing/FakeAppServer.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("opening a Codex session", () => {
  test("logs the app-server it connects to and the thread it is ready on", async () => {
    const dir = newTempDir("pcl-", { short: true });
    cleanup.push(() => removeTempDir(dir));
    const socketPath = join(dir, "s.sock");

    const server = startFakeAppServer(socketPath, (request, conn) => {
      if (request.method === "initialize") return conn.reply({ userAgent: "codex" });

      if (request.method === "thread/start") return conn.reply({ thread: { id: "thr-1" } });
      conn.reply({});
    });

    cleanup.push(server.stop);
    const logs: Array<string> = [];
    const logger = Logger.make((entry) => void logs.push(Logger.formatSimple.log(entry)));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeCodexDriver({
            socketPath,
            spawnAppServer: false,
            codexPath: "/opt/codex",
          });

          yield* driver.open({
            sessionId: SessionId.make("s1"),
            cwd: "/repo",
            permissionMode: "auto",
            model: null,
            effort: null,
            resumeCursor: null,
          });
        })
      ).pipe(Effect.provide(Logger.layer([logger])))
    );

    const lines = logs.filter((line) => line.includes("session s1:"));
    expect(lines[0]).toContain("connecting to the Codex app-server (/opt/codex)");
    expect(lines.at(-1)).toContain("Codex thread thr-1 started; ready");
  });
});
