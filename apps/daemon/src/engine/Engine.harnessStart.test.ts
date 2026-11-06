/** A Harness that never opens, or crashes opening, fails its session instead of leaving it Starting. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement } from "@polaris/protocol";
import { Duration, Effect, Layer } from "effect";
import type { HarnessDriver } from "../harness/HarnessDriver.ts";
import { Checkpoints } from "../services.ts";
import type { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import { shortHostName } from "../service/hostName.ts";
import {
  cid,
  engineLayer,
  type FakeDriver,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
} from "./testing.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const withOpen = (fake: FakeDriver, open: HarnessDriver["open"]): FakeDriver => ({
  ...fake,
  driver: { ...fake.driver, open },
});

const startAndFail = (
  driver: FakeDriver,
  sessionId: SessionId,
  checkpoints?: Layer.Layer<Checkpoints>
) => {
  const options = {
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
    harnessStartTimeout: Duration.millis(50),
  };

  return run(
    engineLayer(checkpoints === undefined ? options : { ...options, checkpoints }),
    Effect.gen(function* () {
      const repo = fakeRepo();
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
      const model = yield* waitFor((m) => [...m.workspaces.values()].some((w) => w.path === repo));
      const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;
      yield* dispatch(
        Command.cases.StartSession.make({
          sessionId,
          workspaceId: workspace.id,
          harness: "codex",
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "Fix the flaky test",
          attachments: [],
        })
      );
      const failed = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "failed");

      return failed.sessions.get(sessionId)!;
    })
  );
};

test.each<[string, () => FakeDriver, Layer.Layer<Checkpoints> | undefined, string]>([
  [
    "a Harness that never finishes opening names itself and the Host",
    () => withOpen(makeFakeDriver("codex"), () => Effect.never),
    undefined,
    `Codex didn't start on ${shortHostName()} after 0 seconds. Check that \`codex --version\` runs there, then retry.`,
  ],
  [
    "a Harness that crashes while opening doesn't hang",
    () => withOpen(makeFakeDriver("codex"), () => Effect.die(new Error("spawn codex ENOENT"))),
    undefined,
    `Codex couldn't start on ${shortHostName()}: spawn codex ENOENT`,
  ],
  [
    "a crash before the Harness opens doesn't leave it Starting",
    () => makeFakeDriver("codex"),
    Layer.succeed(Checkpoints)({ capture: () => Effect.die(new Error("git: index.lock exists")) }),
    "The session couldn't start: git: index.lock exists",
  ],
])("%s: the start fails with its line", async (_, driver, checkpoints, lastError) => {
  const record = await startAndFail(driver(), SessionId.make("s-start-fails"), checkpoints);

  expect(record.session.lastError).toBe(lastError);
  expect(record.turns[0]!.status).toBe("failed");
});
