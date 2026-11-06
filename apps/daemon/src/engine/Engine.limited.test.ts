import { expect, test } from "bun:test";
import { join } from "node:path";
import { Command, SessionId, SessionPlacement, type TurnId } from "@polaris/protocol";
import { Clock, Duration, Effect, Layer, Predicate, Scope } from "effect";
import { TestClock } from "effect/testing";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { CONTINUE_PROMPT } from "./decider.ts";
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

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "MacBook" })
  );

const SESSION = SessionId.make("s-limited");

/** A session whose first Turn the Harness ended at a usage limit. */
const limitedSession = (
  driver: FakeDriver,
  limit: { resetsAt: string | null } | undefined,
  sessionId = SESSION
) =>
  Effect.gen(function* () {
    const repo = fakeRepo();
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
    const model = yield* waitFor((m) => [...m.workspaces.values()].some((w) => w.path === repo));
    const workspace = [...model.workspaces.values()].find((w) => w.path === repo)!;
    yield* dispatch(
      Command.cases.StartSession.make({
        sessionId,
        workspaceId: workspace.id,
        harness: "claude",
        placement: SessionPlacement.cases.InPlace.make({}),
        permissionMode: "supervised",
        model: null,
        effort: null,
        prompt: "Refactor the parser",
        attachments: [],
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");
    const harness = driver.latest(sessionId)!;
    const turnId: TurnId = harness.turns[0]!.turnId;
    harness.emit(
      HarnessEvent.TurnEnded({
        turnId,
        status: "failed",
        error: "You've hit your limit · resets 2pm",
        limit,
      })
    );
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "limited");

    return turnId;
  });

const setResumeAtReset = (sessionId: SessionId, resumeAtReset: boolean) =>
  dispatch(Command.cases.SetResumeAtReset.make({ sessionId, resumeAtReset }));

/** The reset, on a TestClock that starts at 0 and only moves when a test adjusts it. */
const RESET_MS = 60_000;

const RESETS_AT = new Date(RESET_MS).toISOString();

/** The Engine's timers run on `clock`; the test's own waits stay on the live clock. */
const limitedLayer = (driver: FakeDriver, clock: TestClock.TestClock, filename?: string) =>
  engineLayer({
    filename: filename ?? join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
  }).pipe(Layer.provide(Layer.succeed(Clock.Clock)(clock)));

const testClock = () =>
  Effect.runSync(TestClock.make().pipe(Effect.provideService(Scope.Scope, Scope.makeUnsafe())));

/** `clock`, noting every sleep the Engine starts on it (in milliseconds). */
const recording = (clock: TestClock.TestClock) => {
  const sleeps: Array<number> = [];

  const recorded: TestClock.TestClock = {
    ...clock,
    sleep: (duration) => {
      sleeps.push(Duration.toMillis(duration));

      return clock.sleep(duration);
    },
  };

  return { clock: recorded, sleeps };
};

/**
 * Opts a second session in to Resume at reset, moves past the reset and waits for it to
 * resume: a resume due to the session under test at that reset has fired by then.
 */
const resetPassed = (driver: FakeDriver, clock: TestClock.TestClock) =>
  Effect.gen(function* () {
    const control = SessionId.make("s-control");
    yield* limitedSession(driver, { resetsAt: RESETS_AT }, control);
    yield* setResumeAtReset(control, true);
    yield* waitFor((m) => m.sessions.get(control)?.session.resumeAtReset === true);
    yield* clock.adjust(RESET_MS * 2);
    yield* waitFor((m) => m.sessions.get(control)?.session.state === "working");
  });

test("a usage limit leaves the session Limited, with the reset time; nothing resumes by default", async () => {
  const driver = makeFakeDriver("claude");
  const clock = testClock();
  await run(
    limitedLayer(driver, clock),
    Effect.gen(function* () {
      yield* limitedSession(driver, { resetsAt: RESETS_AT });
      const record = (yield* (yield* EventStore).model).sessions.get(SESSION)!;
      expect(record.session.limitResetsAt).toBe(RESETS_AT);
      expect(record.session.resumeAtReset).toBe(false);
      expect(record.turns.at(-1)?.status).toBe("interrupted");
      yield* resetPassed(driver, clock);
      expect((yield* (yield* EventStore).model).sessions.get(SESSION)!.session.state).toBe(
        "limited"
      );
      expect(driver.latest(SESSION)!.turns).toHaveLength(1);
    })
  );
});

test("the Harness's words alone are enough: no hint still reads as a usage limit", async () => {
  const driver = makeFakeDriver("claude");
  await run(
    engineLayer({ filename: join(tempDir(), "s.sqlite"), fakes: makeFakes(), drivers: [driver] }),
    Effect.gen(function* () {
      yield* limitedSession(driver, undefined);
      const model = yield* (yield* EventStore).model;
      expect(model.sessions.get(SESSION)!.session.limitResetsAt).toBeNull();
    })
  );
});

test("Resume at reset continues the same Turn at the reset, and a restart re-arms it", async () => {
  const filename = join(tempDir(), "state.sqlite");
  const before = makeFakeDriver("claude");
  let turnId: TurnId | undefined;

  await run(
    limitedLayer(before, testClock(), filename),
    Effect.gen(function* () {
      turnId = yield* limitedSession(before, { resetsAt: RESETS_AT });
      yield* setResumeAtReset(SESSION, true);
      yield* waitFor((m) => m.sessions.get(SESSION)?.session.resumeAtReset === true);
      // The Daemon stops here, before the reset.
    })
  );

  const after = makeFakeDriver("claude");
  const clock = testClock();
  await run(
    limitedLayer(after, clock, filename),
    Effect.gen(function* () {
      expect((yield* (yield* EventStore).model).sessions.get(SESSION)!.session.state).toBe(
        "limited"
      );
      yield* clock.adjust(RESET_MS);
      yield* waitFor((m) => m.sessions.get(SESSION)?.session.state === "working");
      expect(after.latest(SESSION)!.turns[0]).toMatchObject({ turnId, prompt: CONTINUE_PROMPT });

      const events = yield* (yield* EventStore).readEvents({
        after: 0,
        upTo: (yield* (yield* EventStore).model).sequence,
        sessionId: SESSION,
      });

      const continued = events.findLast((e) => Predicate.isTagged(e.event, "TurnStarted"));
      expect(continued?.commandId).toStartWith("resume-at-reset:");
    })
  );
});

test("turning Resume at reset off before the reset cancels it", async () => {
  const driver = makeFakeDriver("claude");
  const { clock, sleeps } = recording(testClock());
  await run(
    limitedLayer(driver, clock),
    Effect.gen(function* () {
      yield* limitedSession(driver, { resetsAt: RESETS_AT });
      yield* setResumeAtReset(SESSION, true);
      // Armed: the resume sleeps until the reset.
      yield* waitUntil(() => sleeps.includes(RESET_MS));
      yield* setResumeAtReset(SESSION, false);
      yield* resetPassed(driver, clock);
      expect((yield* (yield* EventStore).model).sessions.get(SESSION)!.session.state).toBe(
        "limited"
      );
      expect(driver.latest(SESSION)!.turns).toHaveLength(1);
    })
  );
});
