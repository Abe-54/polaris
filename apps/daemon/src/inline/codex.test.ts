import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Result, Stream } from "effect";
// connectAppServer is connectUnix on POSIX; on Windows it reaches the fake on its loopback port.
import { connectAppServer } from "../harness/codex/AppServer.ts";
import { startFakeAppServer, type Handler } from "../harness/codex/testing/FakeAppServer.ts";
import { codexInline } from "./codex.ts";
import { propose } from "./proposal.ts";
import { request } from "./testing.ts";
import { newTempDir, removeTempDir } from "../platform/tempDir.testing.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const fake = (turn: Handler, readOnly = true) => {
  const root = newTempDir("pi-inline-");
  const path = join(root, "s.sock");

  const server = startFakeAppServer(path, (req, conn) => {
    switch (req.method) {
      case "initialize":
        conn.reply({});
        break;
      case "config/read":
        conn.reply({ config: { mcp_servers: { external: {} }, plugins: { external: {} } } });
        break;
      case "thread/start":
        conn.reply({
          thread: { id: "thread" },
          sandbox: {
            type: readOnly ? "readOnly" : "dangerFullAccess",
            networkAccess: false,
          },
        });
        break;
      case "turn/interrupt":
        conn.reply({});
        break;
      default:
        return turn(req, conn);
    }
  });

  cleanups.push(() => {
    server.stop();
    removeTempDir(root);
  });

  return { path, server };
};

test("Codex starts ephemeral read-only work, disables external tools and validates outputSchema", async () => {
  const patch = { replacements: [{ from: 7, to: 9, text: "changed" }], summary: "Change" };

  const { path, server } = fake((req, conn) => {
    if (req.method !== "turn/start") return;

    conn.reply({ turn: { id: "turn" } });
    conn.notify("item/agentMessage/delta", { threadId: "other", delta: "ignore" });
    conn.notify("item/agentMessage/delta", { threadId: "thread", delta: "proposal" });
    conn.notify("item/completed", {
      threadId: "thread",
      item: { type: "agentMessage", text: JSON.stringify(patch) },
    });
    conn.notify("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "completed" },
    });
  });

  const items = await Effect.runPromise(
    propose(request(), "/repo", codexInline("fake", connectAppServer(path))).pipe(Stream.runCollect)
  );

  expect(items).toHaveLength(2);
  expect(items[1]).toMatchObject({ patch });
  expect(server.requests("thread/start")[0]?.params).toMatchObject({
    ephemeral: true,
    sandbox: "read-only",
    approvalPolicy: "never",
    config: {
      "features.shell_tool": false,
      mcp_servers: { external: { enabled: false } },
      "features.plugins": false,
    },
  });
  expect(server.requests("turn/start")[0]?.params).toMatchObject({
    model: "gpt-test",
    effort: "low",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    outputSchema: { type: "object" },
  });
});

test("cancelling a Codex proposal interrupts its ephemeral Turn", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();

        const { path, server } = fake((req, conn) => {
          if (req.method !== "turn/start") return;

          conn.reply({ turn: { id: "turn" } });

          conn.notify("item/agentMessage/delta", { threadId: "thread", delta: "started" });
        });

        const fiber = yield* Effect.forkScoped(
          propose(request(), "/repo", codexInline("fake", connectAppServer(path))).pipe(
            Stream.tap(() => Deferred.succeed(started, undefined)),
            Stream.runDrain
          )
        );

        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);

        expect(server.requests("turn/interrupt")[0]?.params).toEqual({
          threadId: "thread",
          turnId: "turn",
        });
      })
    )
  );
});

test("Codex refuses a thread whose effective sandbox is not read-only", async () => {
  const { path, server } = fake(() => {}, false);

  const result = await Effect.runPromise(
    propose(request(), "/repo", codexInline("fake", connectAppServer(path))).pipe(
      Stream.runCollect,
      Effect.result
    )
  );

  expect(Result.isFailure(result) && result.failure.reason).toBe("harness-failed");
  expect(server.requests("turn/start")).toHaveLength(0);
});

test("Codex schema rejection never emits a final proposal", async () => {
  const { path } = fake((req, conn) => {
    if (req.method !== "turn/start") return;

    conn.reply({ turn: { id: "turn" } });
    conn.notify("item/completed", {
      threadId: "thread",
      item: { type: "agentMessage", text: '{"summary":"Missing ranges"}' },
    });
    conn.notify("turn/completed", {
      threadId: "thread",
      turn: { id: "turn", status: "completed" },
    });
  });

  const result = await Effect.runPromise(
    propose(request(), "/repo", codexInline("fake", connectAppServer(path))).pipe(
      Stream.runCollect,
      Effect.result
    )
  );

  expect(Result.isFailure(result) && result.failure.reason).toBe("invalid-patch");
});
