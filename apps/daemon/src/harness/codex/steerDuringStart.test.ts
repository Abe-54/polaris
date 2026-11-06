/** The real Engine and Codex driver: a steer can't overtake the `turn/start` that binds its Turn (ENG-796). */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement } from "@polaris/protocol";
import { Effect } from "effect";
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
import { makeCodexDriver } from "./CodexDriver.ts";
import { startFakeAppServer } from "./testing/FakeAppServer.ts";
import { cleanup, scripted, turn } from "./testing/session.ts";

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

test("a steer sent while turn/start is unanswered reaches Codex after the reply, for that Turn", async () => {
  const sessionId = SessionId.make("s-steer-start");
  const socketDir = newTempDir("pcx-", { short: true });
  const socketPath = join(socketDir, "s.sock");
  let answerTurnStart = () => {};

  const server = startFakeAppServer(
    socketPath,
    scripted((request, conn) => {
      if (request.method === "turn/start") answerTurnStart = () => conn.reply({ turn: turn("t1") });

      if (request.method === "turn/steer") conn.reply({ turnId: "t1" });
    })
  );

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
    yield* waitUntil(() => server.requests("turn/start").length === 1, 5000);

    yield* dispatch(Command.cases.Steer.make({ sessionId, text: "also", attachments: [] }));
    answerTurnStart();
    yield* waitUntil(() => server.requests("turn/steer").length === 1, 5000);
  });

  await Effect.runPromise(
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

        yield* program.pipe(Effect.provide(layer));
      })
    )
  );

  expect(server.requests("turn/steer")[0]?.params).toMatchObject({ expectedTurnId: "t1" });
});
