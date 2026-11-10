import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  ContinuityItem,
  DaemonRpcs,
  NotFound,
  SessionId,
  SessionPlacement,
  TurnId,
  unreadTurns,
} from "@polaris/protocol";
import { Effect, Layer, Queue, type Scope, Stream } from "effect";
import { EngineRpcHandlers } from "../engine/rpc.ts";
import {
  cid,
  completesTurns,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "../engine/testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { startServer } from "../transport/server.ts";
import { Continuity, ContinuityRpcsLive } from "./index.ts";
import { TEST_USER_KEY } from "../transport/userAccess.testing.ts";

const handlers = Layer.mergeAll(
  EngineRpcHandlers,
  ContinuityRpcsLive.pipe(Layer.provide(Continuity.layer))
);

const sessionId = SessionId.make("s-continuity");

/** A Daemon on `root` with a session whose two Turns have ended. */
const withDaemon = <A, E>(
  root: string,
  program: (
    connect: () => ReturnType<typeof client>
  ) => Effect.Effect<A, E, EventStore | Scope.Scope>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers,
        });

        return yield* program(() => client(server.socketPath));
      })
    ).pipe(
      Effect.provide(
        engineLayer({
          filename: join(root, "state.sqlite"),
          fakes: makeFakes(),
          drivers: [makeFakeDriver("claude", { onTurn: completesTurns() })],
        })
      )
    )
  );

/** A Desktop App's connection: it presents the test user key, so it may send Turns (ADR 0100). */
const client = (socketPath: string) =>
  Effect.flatMap(socketTransport(socketPath), (transport) =>
    connectRpcWith(DaemonRpcs, transport)
  ).pipe(
    Effect.tap(({ client }) =>
      client.hello({
        clientName: "test",
        clientVersion: "0",
        deviceLabel: "test",
        capabilities: [],
        ...TEST_USER_KEY,
      })
    )
  );

const twoTurns = (desktop: Effect.Success<ReturnType<typeof client>>) =>
  Effect.gen(function* () {
    const repo = fakeRepo();
    yield* desktop.client.dispatch({
      commandId: cid(),
      command: Command.cases.RegisterWorkspace.make({ path: repo, name: null }),
    });
    const model = yield* waitFor((m) => [...m.workspaces.values()].some((w) => w.path === repo));
    const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;
    yield* desktop.client.dispatch({
      commandId: cid(),
      command: Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "First",
        attachments: [],
      }),
    });
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
    yield* desktop.client.dispatch({
      commandId: cid(),
      command: Command.cases.SendTurn.make({ sessionId, prompt: "Second", attachments: [] }),
    });

    const done = yield* waitFor(
      (m) =>
        m.sessions.get(sessionId)?.session.turnCount === 2 &&
        m.sessions.get(sessionId)?.session.state === "idle"
    );

    const record = done.sessions.get(sessionId)!;

    return {
      session: record.session,
      latest: record.turns.at(-1) ?? null,
      turns: record.turns.map((t) => t.id),
    };
  });

/** An item as `[kind, payload]`, to match against. */
type Tagged = readonly [ContinuityItem["_tag"], unknown];

const tagged = (item: ContinuityItem): Tagged =>
  ContinuityItem.match(item, {
    Snapshot: (snapshot): Tagged => ["Snapshot", snapshot],
    Read: ({ position }): Tagged => ["Read", position],
    Draft: ({ draft }): Tagged => ["Draft", draft],
  });

/** Every item a Client's `continuity.watch` sends, in a queue the test takes from. */
const watch = (connection: Effect.Success<ReturnType<typeof client>>) =>
  Effect.gen(function* () {
    const items = yield* Queue.unbounded<ContinuityItem>();
    yield* Effect.forkScoped(
      Stream.runForEach(connection.client["continuity.watch"]({}), (item) =>
        Queue.offer(items, item)
      )
    );

    return items;
  });

test("a draft saved on one Client reaches the other, and back; an unchanged save sends nothing", async () => {
  await withDaemon(tempDir(), (connect) =>
    Effect.gen(function* () {
      const desktop = yield* connect();
      const phone = yield* connect();
      yield* twoTurns(desktop);
      const onPhone = yield* watch(phone);
      const onDesktop = yield* watch(desktop);
      expect(tagged(yield* Queue.take(onPhone))).toMatchObject(["Snapshot", { drafts: [] }]);
      yield* Queue.take(onDesktop);

      yield* desktop.client["continuity.saveDraft"]({ sessionId, text: "Fix the" });
      expect(tagged(yield* Queue.take(onPhone))).toMatchObject([
        "Draft",
        { sessionId, text: "Fix the", revision: 1 },
      ]);

      const saved = yield* phone.client["continuity.saveDraft"]({ sessionId, text: "Fix the bug" });
      expect(saved.revision).toBe(2);
      // Both Clients hear of each change, the saver too: it skips revisions it already has.
      yield* Queue.take(onDesktop);
      expect(tagged(yield* Queue.take(onDesktop))).toMatchObject([
        "Draft",
        { text: "Fix the bug", revision: 2 },
      ]);

      const again = yield* desktop.client["continuity.saveDraft"]({
        sessionId,
        text: "Fix the bug",
      });

      expect(again.revision).toBe(2);
      yield* desktop.client["continuity.saveDraft"]({ sessionId, text: "" });
      // The unchanged save sent nothing: the next item is the emptying.
      expect(yield* Queue.take(onDesktop)).toMatchObject({ draft: { text: "", revision: 3 } });

      // A later watcher's Snapshot carries the emptying, so a Client that missed it clears too.
      const late = yield* watch(yield* connect());
      expect(tagged(yield* Queue.take(late))).toMatchObject([
        "Snapshot",
        { drafts: [{ sessionId, text: "", revision: 3 }] },
      ]);
    })
  );
});

test("the read position is shared, only moves forward, and outlives a Daemon restart", async () => {
  const root = tempDir();

  const unread = await withDaemon(root, (connect) =>
    Effect.gen(function* () {
      const desktop = yield* connect();
      const phone = yield* connect();
      const { session, latest, turns } = yield* twoTurns(desktop);
      const onPhone = yield* watch(phone);
      yield* Queue.take(onPhone);

      yield* desktop.client["continuity.markRead"]({ sessionId, turnId: turns[0]! });
      const first = yield* Queue.take(onPhone);

      const position = ContinuityItem.match(first, {
        Read: ({ position }) => position,
        Snapshot: () => null,
        Draft: () => null,
      });

      expect(position).toMatchObject({ turnIndex: 0 });
      expect(unreadTurns(session, latest, position)).toBe(1);

      yield* phone.client["continuity.markRead"]({ sessionId, turnId: turns[1]! });
      const stale = yield* desktop.client["continuity.markRead"]({ sessionId, turnId: turns[0]! });
      expect(stale.turnIndex).toBe(1);

      const unknown = yield* Effect.flip(
        desktop.client["continuity.markRead"]({ sessionId, turnId: TurnId.make("t-none") })
      );

      expect(unknown).toEqual(new NotFound({ what: "turn", id: "t-none" }));

      return unreadTurns(session, latest, stale);
    })
  );

  expect(unread).toBe(0);

  await withDaemon(root, (connect) =>
    Effect.gen(function* () {
      const snapshot = yield* Queue.take(yield* watch(yield* connect()));
      expect(tagged(snapshot)).toMatchObject([
        "Snapshot",
        { reads: [{ sessionId, turnIndex: 1 }] },
      ]);
    })
  );
});

test("upgrading reads every session through its last ended Turn, so nothing turns unread", async () => {
  const root = tempDir();
  await withDaemon(root, (connect) => Effect.flatMap(connect(), twoTurns));

  // What an older Daemon left, with the second Turn still working.
  const db = new Database(join(root, "state.sqlite"));
  db.run("DROP TABLE session_reads");
  db.run("DROP TABLE session_drafts");
  db.run("DELETE FROM effect_sql_migrations WHERE migration_id >= 6");
  db.run("UPDATE turns SET status = 'working' WHERE turn_index = 1");
  db.close();

  await withDaemon(root, (connect) =>
    Effect.gen(function* () {
      const snapshot = yield* Queue.take(yield* watch(yield* connect()));
      expect(tagged(snapshot)).toMatchObject([
        "Snapshot",
        { reads: [{ sessionId, turnIndex: 0 }] },
      ]);
    })
  );
});
