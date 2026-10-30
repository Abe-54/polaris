/** Steering a working Turn with attachments (ENG-662). */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Attachment, AttachmentId, Command, SessionId, SessionPlacement } from "@polaris/protocol";
import { Effect, Predicate } from "effect";
import type { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  type FakeDriver,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const screenshot = new Attachment({
  id: AttachmentId.make("att-shot"),
  name: "shot.png",
  mimeType: "image/png",
  size: 10,
  hostPath: "/staging/s/shot.png",
  width: 4,
  height: 3,
});

/** A session whose first Turn is still working, and a staged screenshot. */
const run = <A, E>(
  driver: FakeDriver,
  program: (sessionId: SessionId) => Effect.Effect<A, E, Engine | EventStore>
) => {
  const fakes = makeFakes();
  fakes.attachments.set(screenshot.id, screenshot);
  const sessionId = SessionId.make(`s-steer-${driver.driver.kind}`);

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes,
    drivers: [driver],
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
      const model = yield* waitFor((m) => m.workspaces.size > 0);
      const workspace = [...model.workspaces.values()][0]!;

      yield* dispatch(
        Command.cases.StartSession.make({
          sessionId,
          workspaceId: workspace.id,
          harness: driver.driver.kind,
          placement: SessionPlacement.cases.InPlace.make({}),
          permissionMode: "supervised",
          model: null,
          effort: null,
          prompt: "go",
          attachments: [],
        })
      );
      yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");

      return yield* program(sessionId);
    }).pipe(Effect.provide(layer))
  );
};

const refusal = (sessionId: SessionId, attachments: ReadonlyArray<AttachmentId>) =>
  Effect.flip(
    dispatch(
      Command.cases.Steer.make({ sessionId, text: "like this", attachments: [...attachments] })
    )
  ).pipe(
    Effect.map((rejected) =>
      Predicate.isTagged(rejected, "CommandRejected") ? rejected.reason : rejected._tag
    )
  );

test("a steer's attachments reach the Harness with the text, resolved from staging", async () => {
  const driver = makeFakeDriver("claude", { steer: true });

  await run(driver, (sessionId) =>
    Effect.gen(function* () {
      yield* dispatch(
        Command.cases.Steer.make({ sessionId, text: "like this", attachments: [screenshot.id] })
      );
      const harness = driver.latest(sessionId)!;
      yield* waitUntil(() => harness.steers.length === 1, 5000);

      expect(harness.steers).toEqual(["like this"]);
      expect(harness.steerAttachments).toEqual([[screenshot]]);
    })
  );
});

test("a steer with attachments is refused where the Harness can't take them mid-Turn", async () => {
  const driver = makeFakeDriver("codex", { steer: true, steerAttachments: false });

  const reason = await run(driver, (sessionId) => refusal(sessionId, [screenshot.id]));

  expect(reason).toBe("codex can't take attachments in a steer");
});

test("a steer naming an attachment that isn't staged is refused", async () => {
  const driver = makeFakeDriver("claude", { steer: true });

  const reason = await run(driver, (sessionId) =>
    refusal(sessionId, [AttachmentId.make("att-gone")])
  );

  expect(reason).toBe("unknown attachments: att-gone");
});
