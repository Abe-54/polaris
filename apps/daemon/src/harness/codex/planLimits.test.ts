import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PlanLimit, SessionId, TurnId } from "@polaris/protocol";
import { Effect, Schema, Stream } from "effect";
import { HarnessEvent, type HarnessSession } from "../HarnessDriver.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import { type FakeConnection, startFakeAppServer } from "./testing/FakeAppServer.ts";
import { THREAD, turn } from "./testing/session.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const realRead = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
  readFileSync(join(import.meta.dir, "../limits/fixtures/codex-rate-limits-read.json"), "utf8")
);

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const until = async (predicate: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;

    await Bun.sleep(2);
  }

  throw new Error(`timed out waiting for ${label}`);
};

/** Opens a Codex session on a fake app-server; `connection` is the session's, once it asked. */
const run = async (
  readReply: (conn: FakeConnection) => void,
  body: (h: {
    readonly reported: Array<PlanLimit>;
    readonly connection: () => FakeConnection;
    readonly readRequested: () => boolean;
    readonly session: HarnessSession;
  }) => Promise<void>
) => {
  // Socket paths must stay under ~104 bytes.
  const dir = newTempDir("pcl-", { short: true });
  cleanup.push(() => removeTempDir(dir));
  const path = join(dir, "s.sock");
  let connection: FakeConnection | null = null;

  const server = startFakeAppServer(path, (request, conn) => {
    if (request.method === "initialize") return conn.reply({ userAgent: "fake" });

    if (request.method === "thread/start") return conn.reply({ thread: { id: THREAD } });

    if (request.method === "turn/start") {
      conn.reply({ turn: turn("t1") });
      conn.notify("turn/started", { threadId: THREAD, turn: turn("t1") });

      return conn.notify("turn/completed", { threadId: THREAD, turn: turn("t1", "completed") });
    }

    if (request.method === "thread/unsubscribe") return conn.reply({ status: "unsubscribed" });

    if (request.method === "account/rateLimits/read") {
      connection = conn;
      readReply(conn);
    }
  });

  cleanup.push(server.stop);
  const reported: Array<PlanLimit> = [];

  const program = Effect.gen(function* () {
    const driver = yield* makeCodexDriver({
      socketPath: path,
      spawnAppServer: false,
      codexPath: "/opt/codex/bin/codex",
      planLimits: { report: (limits) => reported.push(...limits) },
    });

    const session = yield* driver.open({
      sessionId: SessionId.make("s1"),
      cwd: "/repo",
      permissionMode: "supervised",
      model: null,
      effort: null,
      resumeCursor: null,
    });

    yield* Effect.promise(() =>
      body({
        reported,
        connection: () => {
          if (connection === null) throw new Error("no rate-limit read yet");

          return connection;
        },
        readRequested: () => connection !== null,
        session,
      })
    );
  });

  await Effect.runPromise(Effect.scoped(program));

  return server;
};

describe("Codex Plan Limits", () => {
  test("reads the account's rate limits when a session connects, then merges updates", async () => {
    const seen: Array<PlanLimit> = [];

    const server = await run(
      (conn) => conn.reply(realRead),
      async ({ reported, connection }) => {
        await until(() => reported.length === 1, "the read");

        // Sparse: no plan and no windows; the weekly window it leaves out keeps its last value.
        connection().notify("account/rateLimits/updated", {
          rateLimits: { limitId: "codex", primary: null, secondary: null, planType: null },
        });
        await until(() => reported.length === 2, "the update");
        seen.push(...reported);
      }
    );

    // The update named no window, so the weekly one keeps every value from the read.
    expect(
      seen.map((l) => [l.kind, l.windowMinutes, l.usedPercent, l.resetsAt, l.status, l.plan])
    ).toEqual([
      ["weekly", 10080, 7, "2026-10-04T07:16:26.000Z", "ok", "prolite"],
      ["weekly", 10080, 7, "2026-10-04T07:16:26.000Z", "ok", "prolite"],
    ]);

    expect(server.requests("account/rateLimits/read")[0]?.params).toEqual({});
    // Nothing account- or credential-related beyond the read itself.
    expect(
      [...new Set(server.received.map((m) => m.method ?? ""))].sort((a, b) => a.localeCompare(b))
    ).toEqual([
      "account/rateLimits/read",
      "initialize",
      "initialized",
      "thread/start",
      "thread/unsubscribe",
    ]);
  });

  test("a failed read (not signed in) leaves the session working and reports nothing", async () => {
    const seen: Array<PlanLimit> = [];
    const ended: Array<string> = [];

    const server = await run(
      (conn) => conn.replyError(-32600, "not signed in"),
      async ({ reported, readRequested, session }) => {
        await until(readRequested, "the read");

        const turnEnded = Effect.runPromise(
          session.events.pipe(
            Stream.filter(HarnessEvent.$is("TurnEnded")),
            Stream.take(1),
            Stream.runCollect
          )
        );

        await Effect.runPromise(
          session.sendTurn({
            turnId: TurnId.make("turn-1"),
            prompt: "hi",
            attachments: [],
            model: null,
            effort: null,
          })
        );
        ended.push(...[...(await turnEnded)].map((e) => e.status));
        seen.push(...reported);
      }
    );

    expect(server.requests("account/rateLimits/read")).toHaveLength(1);
    expect(ended).toEqual(["completed"]);
    expect(seen).toEqual([]);
  });
});
