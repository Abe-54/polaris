/** The real Engine and Codex driver: a steer Codex doesn't take stays in its Turn, refused (ENG-797). */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Command,
  DomainEvent,
  SessionId,
  SessionPlacement,
  type TurnItem,
} from "@polaris/protocol";
import { Duration, Effect } from "effect";
import { Engine } from "../../engine/Engine.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "../../engine/testing.ts";
import { newTempDir } from "../../platform/tempDir.testing.ts";
import { EventStore } from "../../store/EventStore.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import type { FakeAppServer, FakeConnection, Handler } from "./testing/FakeAppServer.ts";
import { startFakeAppServer } from "./testing/FakeAppServer.ts";
import { cleanup, scripted, THREAD, turn } from "./testing/session.ts";

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const sessionId = SessionId.make("s-steer-refused");

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const started = (conn: FakeConnection, id: string) =>
  conn.notify("turn/started", { threadId: THREAD, turn: turn(id) });

const completed = (conn: FakeConnection, id: string) =>
  conn.notify("turn/completed", { threadId: THREAD, turn: turn(id, "completed") });

/** The items recorded in the session's Turns, waiting until `count` have been. */
const items = (count: number) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const deadline = Date.now() + 2000;

    for (;;) {
      const model = yield* store.model;
      const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId });

      const found = events.flatMap((envelope) =>
        DomainEvent.guards.TurnItemCompleted(envelope.event) ? [envelope.event] : []
      );

      if (found.length >= count || Date.now() > deadline) return found;
      yield* Effect.sleep(Duration.millis(5));
    }
  });

const refusedIn = (found: ReadonlyArray<{ readonly item: TurnItem }>) =>
  found.flatMap(({ item }) =>
    item.id.startsWith("refused:") || item.id.startsWith("refusal:") ? [item] : []
  );

const runEngine = <A, E>(
  handler: Handler,
  body: (server: FakeAppServer) => Effect.Effect<A, E, Engine | EventStore>
) => {
  const socketDir = newTempDir("pcx-", { short: true });
  const socketPath = join(socketDir, "s.sock");
  const server = startFakeAppServer(socketPath, handler);

  cleanup.push(server.stop);

  const program = Effect.gen(function* () {
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
    const model = yield* waitFor((m) => m.workspaces.size > 0);
    const workspace = [...model.workspaces.values()][0]!;

    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "codex",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "go",
        attachments: [],
      })
    );

    return yield* body(server);
  });

  return {
    server,
    run: Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const driver = yield* makeCodexDriver({
            socketPath,
            spawnAppServer: false,
            codexPath: "/opt/codex/bin/codex",
          });

          const layer = engineLayer({
            filename: join(tempDir(), "state.sqlite"),
            fakes: makeFakes(),
            drivers: [
              {
                driver,
                sessions: [],
                latest: () => undefined,
                follow: { emit: () => {}, released: [] },
              },
            ],
          });

          return yield* program.pipe(Effect.provide(layer));
        })
      )
    ),
  };
};

const idle = (m: { sessions: ReadonlyMap<SessionId, { session: { state: string } }> }) =>
  m.sessions.get(sessionId)?.session.state === "idle";

test("a steer sent while /compact waits for its turn/started stays in the Turn, refused", async () => {
  // The order `fixtures/slash-turns.jsonl` recorded: compact's reply comes before its turn/started.
  let connection: FakeConnection | null = null;

  const { server, run } = runEngine(
    scripted((request, conn) => {
      connection = conn;

      if (request.method === "turn/start") {
        conn.reply({ turn: turn("t1") });
        started(conn, "t1");
        completed(conn, "t1");
      }

      if (request.method === "thread/compact/start") conn.reply({});

      if (request.method === "turn/steer") conn.reply({ turnId: "c1" });
    }),
    (server) =>
      Effect.gen(function* () {
        yield* waitFor(idle, 5000, "the first Turn ends");
        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId, prompt: "/compact", attachments: [] })
        );
        yield* waitUntil(() => server.requests("thread/compact/start").length === 1, 5000);

        yield* dispatch(
          Command.cases.Steer.make({ sessionId, text: "then fix the tests", attachments: [] })
        );
        const found = yield* items(2);
        const compactTurn = (yield* waitFor(() => true)).sessions.get(sessionId)!.turns.at(-1)!;

        started(connection!, "c1");
        completed(connection!, "c1");
        yield* waitFor(idle, 5000, "the compact Turn ends");

        return { found, compactTurn };
      })
  );

  const { found, compactTurn } = await run;

  expect(server.requests("turn/steer")).toHaveLength(0);
  expect(found.every((event) => event.turnId === compactTurn.id)).toBe(true);
  expect(refusedIn(found).map((item) => item._tag)).toEqual(["UserMessage", "Error"]);
  expect(refusedIn(found)).toMatchObject([
    { text: "then fix the tests" },
    { message: "This message didn't reach the agent: No Turn is in progress to steer" },
  ]);
});

test("a steer Codex refuses on its running Turn stays in the Turn, refused", async () => {
  let connection: FakeConnection | null = null;

  const { server, run } = runEngine(
    scripted((request, conn) => {
      connection = conn;

      if (request.method === "turn/start") {
        conn.reply({ turn: turn("t1") });
        started(conn, "t1");
      }

      // What Codex answers a steer on a compact or review Turn (NonSteerableTurnKind).
      if (request.method === "turn/steer") conn.replyError(-32600, "cannot steer a compact turn");
    }),
    (server) =>
      Effect.gen(function* () {
        yield* waitUntil(() => server.requests("turn/start").length === 1, 5000);
        yield* dispatch(
          Command.cases.Steer.make({ sessionId, text: "also lint", attachments: [] })
        );
        const found = yield* items(2);

        completed(connection!, "t1");
        yield* waitFor(idle, 5000, "the Turn ends");

        return found;
      })
  );

  const found = await run;

  expect(server.requests("turn/steer")).toHaveLength(1);
  expect(refusedIn(found).map((item) => item._tag)).toEqual(["UserMessage", "Error"]);
  expect(refusedIn(found)[0]).toMatchObject({ text: "also lint" });
  expect(refusedIn(found)[1]).toMatchObject({
    message:
      "This message didn't reach the agent: turn/steer: cannot steer a compact turn (code -32600)",
  });
});
