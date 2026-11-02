import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionId, TurnId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { makeCodexDriver } from "./CodexDriver.ts";
import { startFakeAppServer } from "./testing/FakeAppServer.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const Params = Schema.Struct({
  approvalsReviewer: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
});

const readParams = Schema.decodeUnknownSync(Params);

describe("an older Codex app-server", () => {
  test("refusing newer fields gets the request again without them; the Turn runs", async () => {
    const dir = newTempDir("pcc-", { short: true });
    cleanup.push(() => removeTempDir(dir));
    const socketPath = join(dir, "s.sock");

    // Like an app-server from before `auto_review` and per-Turn effort.
    const server = startFakeAppServer(socketPath, (request, conn) => {
      const params = readParams(request.params ?? {});

      if (request.method === "initialize") return conn.reply({ userAgent: "old" });

      if (params.approvalsReviewer === "auto_review" || params.effort !== undefined) {
        return conn.replyError(-32602, "unknown variant `auto_review`");
      }

      if (request.method === "thread/start") return conn.reply({ thread: { id: "thr" } });

      if (request.method === "turn/start") return conn.reply({ turn: { id: "ct1" } });
      conn.reply({});
    });

    cleanup.push(server.stop);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeCodexDriver({
            socketPath,
            spawnAppServer: false,
            codexPath: "/opt/codex",
          });

          const session = yield* driver.open({
            sessionId: SessionId.make("s1"),
            cwd: "/repo",
            permissionMode: "auto",
            model: null,
            effort: null,
            resumeCursor: null,
          });

          yield* session.sendTurn({
            turnId: TurnId.make("t1"),
            prompt: "hi",
            attachments: [],
            model: "gpt-5.5",
            effort: "high",
          });
        })
      )
    );

    const sent = (method: string) => server.requests(method).map((r) => readParams(r.params));

    expect(sent("thread/start")).toEqual([{ approvalsReviewer: "auto_review" }, {}]);
    expect(sent("turn/start")).toEqual([
      { approvalsReviewer: "auto_review", effort: "high", model: "gpt-5.5" },
      { model: "gpt-5.5" },
    ]);
  });
});
