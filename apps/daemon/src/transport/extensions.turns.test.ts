import { expect, test } from "bun:test";
import { join } from "node:path";
import { connectRpcWith, socketTransport } from "@polaris/client";
import {
  Command,
  ExtensionClientRpcs,
  NotGranted,
  SessionId,
  SessionPlacement,
} from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { EngineRpcHandlers } from "../engine/rpc.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "../engine/testing.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { startServer } from "./server.ts";

test("the socket carries the Pairing's Grant into the Engine and returns its typed refusal", async () => {
  const root = tempDir();
  const driver = makeFakeDriver("codex");

  const engine = engineLayer({
    filename: join(root, "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startServer({
          root,
          socketPath: join(root, "d.sock"),
          lockPath: join(root, "d.lock"),
          handlers: EngineRpcHandlers,
        });

        const connect = () =>
          Effect.flatMap(socketTransport(server.socketPath), (transport) =>
            connectRpcWith(ExtensionClientRpcs, transport)
          );

        const desktop = yield* connect();

        const paired = yield* desktop.client["extensions.pair"]({
          name: "Turn sender",
          grant: ["turn"],
        });

        const extension = yield* connect();
        yield* extension.client.hello({
          clientName: "test",
          clientVersion: "0",
          deviceLabel: "test",
          capabilities: [],
          extensionToken: Redacted.make(paired.token),
        });
        const repo = fakeRepo();
        yield* desktop.client.dispatch({
          commandId: cid(),
          command: Command.cases.RegisterWorkspace.make({ path: repo, name: null }),
        });

        const model = yield* waitFor((m) =>
          [...m.workspaces.values()].some((w) => w.path === repo)
        );

        const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;
        const sessionId = SessionId.make("s-rpc-grants");
        yield* desktop.client.dispatch({
          commandId: cid(),
          command: Command.cases.StartSession.make({
            sessionId,
            workspaceId: workspace.id,
            harness: "codex",
            placement: SessionPlacement.cases.InPlace.make({}),
            permissionMode: "full-access",
            model: null,
            effort: null,
            prompt: "Initial",
            attachments: [],
          }),
        });
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");

        const harness = driver.latest(sessionId)!;
        harness.emit(
          HarnessEvent.TurnEnded({
            turnId: harness.turns[0]!.turnId,
            status: "completed",
            error: null,
          })
        );
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");

        const commands = [
          Command.cases.SendTurn.make({ sessionId, prompt: "Next", attachments: [] }),
          Command.cases.Steer.make({ sessionId, text: "Next" }),
          Command.cases.Continue.make({ sessionId }),
          Command.cases.Retry.make({ sessionId }),
        ];

        for (const command of commands) {
          expect(
            yield* Effect.flip(extension.client.dispatch({ commandId: cid(), command }))
          ).toEqual(new NotGranted({ what: `dispatch:${command._tag}`, needed: "approve" }));
        }

        expect(driver.sessions.flatMap((s) => s.turns)).toHaveLength(1);
      })
    ).pipe(Effect.provide(engine))
  );
});
