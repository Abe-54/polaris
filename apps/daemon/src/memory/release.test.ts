import { beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement, type WorkspaceId } from "@polaris/protocol";
import { Clock, Duration, Effect, Layer, Scope } from "effect";
import { TestClock } from "effect/testing";
import { Engine } from "../engine/Engine.ts";
import {
  cid,
  engineLayer,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "../engine/testing.ts";
import { readVersioned } from "../files/version.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { workingTurn } from "../store/model.ts";
import { clearFileReads, RELEASE_AFTER_READ_BYTES } from "./fileReads.ts";
import { QUIET_AFTER, releaseWhenQuiet } from "./release.ts";

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const start = (workspaceId: WorkspaceId, sessionId: SessionId) =>
  dispatch(
    Command.cases.StartSession.make({
      sessionId,
      workspaceId,
      harness: "claude",
      placement: SessionPlacement.cases.InPlace.make({}),
      permissionMode: "supervised",
      model: null,
      effort: null,
      prompt: "Fix the flaky test",
      attachments: [],
    })
  );

/** A TestClock that notes each timed sleep started on it, in milliseconds. */
const recordingClock = () => {
  const clock = Effect.runSync(
    TestClock.make().pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe()))
  );

  const sleeps: Array<number> = [];

  const recorded: TestClock.TestClock = {
    ...clock,
    sleep: (duration) => {
      // A zero sleep is a yield: the debounce polls with them while the clock stands still.
      if (Duration.toMillis(duration) > 0) sleeps.push(Duration.toMillis(duration));

      return clock.sleep(duration);
    },
  };

  return { clock: recorded, sleeps };
};

describe("releaseWhenQuiet", () => {
  beforeEach(clearFileReads);

  test("releases once, after the last Turn in flight ends and the Daemon stays quiet", async () => {
    const claude = makeFakeDriver("claude");
    const { clock, sleeps } = recordingClock();
    const quietMs = Duration.toMillis(QUIET_AFTER);
    // When each release ran, on the quiet timer's clock.
    const releases: Array<number> = [];

    const release = releaseWhenQuiet({
      release: Effect.sync(() => void releases.push(clock.currentTimeMillisUnsafe())),
    }).pipe(Layer.provide(Layer.succeed(Clock.Clock)(clock)));

    const engine = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [claude],
    });

    const layer = Layer.provideMerge(release, engine);

    const program = Effect.gen(function* () {
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
      const workspace = [...(yield* waitFor((m) => m.workspaces.size > 0)).workspaces.values()][0]!;
      const a = SessionId.make("s-a");
      const b = SessionId.make("s-b");
      yield* start(workspace.id, a);
      yield* start(workspace.id, b);

      const model = yield* waitFor((m) =>
        [a, b].every((s) => m.sessions.get(s)?.session.state === "working")
      );

      /** Ends the session's Turn, waits for its quiet timer and lets it run out. */
      const endThenQuiet = (sessionId: SessionId, timers: number) =>
        Effect.gen(function* () {
          const turnId = workingTurn(model.sessions.get(sessionId)!)!.id;
          claude
            .latest(sessionId)!
            .emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
          yield* waitUntil(() => sleeps.length === timers);
          yield* clock.adjust(QUIET_AFTER);
        });

      // One Turn ends while the other still runs: not quiet, so its timer releases nothing.
      yield* endThenQuiet(a, 1);
      yield* endThenQuiet(b, 2);
      yield* waitUntil(() => releases.length > 0);
      expect(releases).toEqual([2 * quietMs]);

      // Quiet stays quiet: no timer wakes an idle Daemon.
      yield* clock.adjust(Duration.hours(1));
      expect(sleeps).toEqual([quietMs, quietMs]);
      expect(releases).toHaveLength(1);
    });

    await Effect.runPromise(program.pipe(Effect.provide(layer)));
  });

  test("a burst of file reads releases once, and only with no Turn in flight", async () => {
    const claude = makeFakeDriver("claude");
    const { clock, sleeps } = recordingClock();
    const quietMs = Duration.toMillis(QUIET_AFTER);
    const releases: Array<number> = [];

    const release = releaseWhenQuiet({
      release: Effect.sync(() => void releases.push(clock.currentTimeMillisUnsafe())),
    }).pipe(Layer.provide(Layer.succeed(Clock.Clock)(clock)));

    const engine = engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [claude],
    });

    const quarter = join(tempDir(), "quarter.txt");

    const readBurst = (reads: number) =>
      Effect.promise(async () => {
        for (let read = 0; read < reads; read++) await readVersioned(quarter);
      });

    const program = Effect.gen(function* () {
      yield* Effect.promise(() => writeFile(quarter, "x".repeat(RELEASE_AFTER_READ_BYTES / 4)));

      // Three quarters of the threshold start no timer, however long the Daemon then waits.
      yield* readBurst(3);
      yield* clock.adjust(Duration.hours(1));
      expect(sleeps).toEqual([]);

      // The read that crosses it does, and the release comes after the quiet spell.
      const crossedAt = clock.currentTimeMillisUnsafe();
      yield* readBurst(1);
      yield* waitUntil(() => sleeps.length === 1);
      yield* clock.adjust(QUIET_AFTER);
      yield* waitUntil(() => releases.length === 1);
      expect(releases).toEqual([crossedAt + quietMs]);

      // The release starts the count again.
      yield* readBurst(3);
      yield* clock.adjust(Duration.hours(1));
      expect(sleeps).toEqual([quietMs]);
      yield* readBurst(1);
      yield* waitUntil(() => sleeps.length === 2);
      yield* clock.adjust(QUIET_AFTER);
      yield* waitUntil(() => releases.length === 2);

      // With a Turn in flight the spell passes unreleased; the Turn's end releases.
      yield* dispatch(Command.cases.RegisterWorkspace.make({ path: fakeRepo(), name: null }));
      const workspace = [...(yield* waitFor((m) => m.workspaces.size > 0)).workspaces.values()][0]!;
      const sessionId = SessionId.make("s-a");
      yield* start(workspace.id, sessionId);
      const model = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");

      yield* readBurst(4);
      yield* waitUntil(() => sleeps.length === 3);
      yield* clock.adjust(QUIET_AFTER);
      expect(releases).toHaveLength(2);

      const turnId = workingTurn(model.sessions.get(sessionId)!)!.id;
      claude
        .latest(sessionId)!
        .emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
      yield* waitUntil(() => sleeps.length === 4);
      yield* clock.adjust(QUIET_AFTER);
      yield* waitUntil(() => releases.length === 3);
    });

    await Effect.runPromise(program.pipe(Effect.provide(Layer.provideMerge(release, engine))));
  });
});
