import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  Command,
  BackgroundTask,
  DomainEvent,
  SessionId,
  SessionPlacement,
  type SessionStreamItem,
  SubagentId,
  TurnId,
  TurnTrigger,
  TurnItem,
} from "@polaris/protocol";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Predicate, Stream } from "effect";
import { Checkpoints } from "../services.ts";
import { HarnessEvent } from "../harness/HarnessDriver.ts";
import { EventStore } from "../store/EventStore.ts";
import { Engine } from "./Engine.ts";
import {
  cid,
  engineLayer,
  type FakeDriver,
  fakeRepo,
  makeFakeDriver,
  makeFakes,
  tempDir,
  waitFor,
  waitUntil,
} from "./testing.ts";

type Env = Engine | EventStore;

const run = <A, E>(layer: Layer.Layer<Env>, program: Effect.Effect<A, E, Env>) =>
  Effect.runPromise(program.pipe(Effect.provide(layer)));

const SUB = SubagentId.make("sub-1");

const dispatch = (command: Command) =>
  Effect.flatMap(Engine, (engine) =>
    engine.dispatch({ commandId: cid(), command, deviceLabel: "test" })
  );

const layerWith = (driver: FakeDriver) =>
  engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
  });

/** A Codex-like session with its first Turn in flight; returns the Turn's id. */
const startWorking = (driver: FakeDriver, sessionId: SessionId) =>
  Effect.gen(function* () {
    const repo = fakeRepo();
    yield* dispatch(Command.cases.RegisterWorkspace.make({ path: repo, name: null }));
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
    yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "working");

    return driver.latest(sessionId)!.turns[0]!.turnId;
  });

const spawn = (turnId: TurnId, background = false) =>
  HarnessEvent.SubagentStarted({
    turnId,
    subagentId: SUB,
    parentItemId: "call-1",
    title: "Check frame timing",
    agent: "Explore",
    model: "haiku",
    background,
  });

const subItem = (turnId: TurnId) =>
  HarnessEvent.ItemCompleted({
    turnId,
    subagentId: SUB,
    item: TurnItem.cases.AssistantMessage.make({ id: "sub-m1", text: "measured" }),
  });

/** Everything a session stream sends, for Clients with and without `session.subagents`. */
const collect = (sessionId: SessionId, subagents: boolean) =>
  Effect.gen(function* () {
    const engine = yield* Engine;
    const items: Array<SessionStreamItem> = [];

    const fiber = yield* Stream.runForEach(
      engine.subscribeSession({
        sessionId,
        afterSequence: null,
        turnLimit: null,
        subagents,
        capabilities: ["session.background-tasks"],
      }),
      (item) => Effect.sync(() => void items.push(item))
    ).pipe(Effect.forkChild);

    yield* waitUntil(() => items.some((i) => Predicate.isTagged(i, "Synchronized")));

    return { items, stop: Fiber.interrupt(fiber) };
  });

/**
 * Ends a Turn of `control`, which has no background work, and waits for its idle stop: any
 * plain idle timer armed earlier, with the same timeout, has fired by then.
 */
const idleTimeoutElapsed = (driver: FakeDriver, control: SessionId, turns: number) =>
  Effect.gen(function* () {
    const model = yield* waitFor((m) => m.sessions.get(control)?.turns.length === turns);
    const turnId = model.sessions.get(control)!.turns.at(-1)!.id;
    yield* waitUntil(() => driver.latest(control)?.turns.at(-1)?.turnId === turnId);
    driver
      .latest(control)!
      .emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
    yield* waitFor(
      (m) =>
        m.sessions.get(control)?.turns.length === turns &&
        m.sessions.get(control)?.session.state === "dormant"
    );
  });

const tags = (items: ReadonlyArray<SessionStreamItem>) =>
  items.flatMap((i) => {
    if (Predicate.isTagged(i, "Event")) return [i.envelope.event._tag];

    return Predicate.isTagged(i, "Delta") ? [`Delta:${i.subagentId ?? "turn"}`] : [];
  });

describe("Subagents", () => {
  test("recorded with their own items; only Clients that announced them see them", async () => {
    const codex = makeFakeDriver("codex");
    await run(
      layerWith(codex),
      Effect.gen(function* () {
        const s = SessionId.make("s-sub");
        const turnId = yield* startWorking(codex, s);
        const withSubagents = yield* collect(s, true);
        const without = yield* collect(s, false);
        const harness = codex.latest(s)!;

        harness.emit(
          spawn(turnId),
          HarnessEvent.ItemDelta({
            turnId,
            subagentId: SUB,
            itemId: "sub-m1",
            field: "text",
            text: "me",
          }),
          subItem(turnId),
          HarnessEvent.ItemDelta({ turnId, itemId: "m1", field: "text", text: "ok" })
        );
        const opened = yield* waitFor((m) => m.sessions.get(s)?.subagents.has(SUB) === true);
        expect(opened.sessions.get(s)!.subagents.get(SUB)).toMatchObject({ status: "working" });

        harness.emit(
          HarnessEvent.SubagentEnded({ subagentId: SUB, status: "completed" }),
          HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
        );
        yield* waitFor((m) => m.sessions.get(s)?.session.state === "idle");
        yield* Effect.sleep(Duration.millis(20));
        yield* withSubagents.stop;
        yield* without.stop;

        expect(tags(withSubagents.items)).toEqual([
          "SubagentStarted",
          `Delta:${SUB}`,
          "TurnItemCompleted",
          "Delta:turn",
          "SubagentEnded",
          "CheckpointRecorded",
          "TurnEnded",
          "SessionStateChanged",
        ]);
        expect(tags(without.items)).toEqual([
          "Delta:turn",
          "CheckpointRecorded",
          "TurnEnded",
          "SessionStateChanged",
        ]);

        // A fresh snapshot: the Subagent under its Turn with its own items, only for those Clients.
        const again = yield* collect(s, true);
        const plain = yield* collect(s, false);
        yield* again.stop;
        yield* plain.stop;
        const [snapshot] = again.items;
        const [plainSnapshot] = plain.items;

        if (
          !Predicate.isTagged(snapshot, "Snapshot") ||
          !Predicate.isTagged(plainSnapshot, "Snapshot")
        )
          throw new Error("no snapshot");
        const [detail] = snapshot.turns[0]!.subagents;
        expect(detail?.subagent).toMatchObject({
          id: SUB,
          turnId,
          parentItemId: "call-1",
          title: "Check frame timing",
          status: "completed",
        });
        expect(detail?.items.map((i) => i.id)).toEqual(["sub-m1"]);
        expect(snapshot.turns[0]!.items.map((i) => i.id)).not.toContain("sub-m1");
        expect(plainSnapshot.turns[0]!.subagents).toEqual([]);
        expect(plainSnapshot.turns[0]!.items.map((i) => i.id)).not.toContain("sub-m1");
      })
    );
  });

  test("a Subagent may outlive its Turn; the Harness exiting ends what is left", async () => {
    const codex = makeFakeDriver("codex");
    await run(
      layerWith(codex),
      Effect.gen(function* () {
        const s = SessionId.make("s-outlive");
        const turnId = yield* startWorking(codex, s);
        const harness = codex.latest(s)!;
        harness.emit(
          spawn(turnId),
          HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
        );
        yield* waitFor((m) => m.sessions.get(s)?.session.state === "idle");
        // Still working after its Turn, and its items still arrive.
        harness.emit(subItem(turnId));
        const idle = yield* waitFor((m) => m.sessions.get(s)?.subagents.has(SUB) === true);
        expect(idle.sessions.get(s)!.subagents.get(SUB)?.status).toBe("working");

        harness.emit(HarnessEvent.Exited({ error: null }));
        const closed = yield* waitFor((m) => m.sessions.get(s)?.subagents.size === 0);
        expect(closed.sessions.get(s)!.session.state).toBe("dormant");

        const store = yield* EventStore;
        const events = yield* store.readEvents({ after: 0, upTo: closed.sequence, sessionId: s });
        const ended = events.map((e) => e.event).find(DomainEvent.guards.SubagentEnded);
        expect(ended?.subagent).toMatchObject({ id: SUB, status: "interrupted" });
        expect(ended?.subagent.endedAt).not.toBeNull();
      })
    );
  });

  test("a Subagent for a Turn that isn't in flight is ignored", async () => {
    const codex = makeFakeDriver("codex");
    await run(
      layerWith(codex),
      Effect.gen(function* () {
        const s = SessionId.make("s-stale");
        const turnId = yield* startWorking(codex, s);
        const harness = codex.latest(s)!;
        harness.emit(HarnessEvent.TurnEnded({ turnId, status: "completed", error: null }));
        yield* waitFor((m) => m.sessions.get(s)?.session.state === "idle");
        harness.emit(
          spawn(turnId),
          HarnessEvent.SubagentEnded({ subagentId: SUB, status: "completed" })
        );
        yield* Effect.sleep(Duration.millis(30));

        const store = yield* EventStore;
        const model = yield* store.model;
        const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId: s });
        expect(events.some((e) => e.event._tag.startsWith("Subagent"))).toBe(false);
      })
    );
  });
});

test.each<Array<"subagent" | "command">[number]>(["subagent", "command"])(
  "%s background waiting survives idle timeout; report and continuation are streamed and snapshotted",
  async (kind) => {
    const driver = makeFakeDriver("codex");
    await run(
      engineLayer({
        filename: join(tempDir(), "state.sqlite"),
        fakes: makeFakes(),
        drivers: [driver],
        idleTimeout: Duration.millis(50),
      }),
      Effect.gen(function* () {
        const sessionId = SessionId.make("s-background");
        const turnId = yield* startWorking(driver, sessionId);
        const stream = yield* collect(sessionId, true);
        const harness = driver.latest(sessionId)!;
        harness.emit(
          HarnessEvent.BackgroundTasksChanged({
            tasks: [new BackgroundTask({ id: "bg-task", kind, description: "Background work" })],
          }),
          ...(kind === "subagent" ? [spawn(turnId, true)] : []),
          HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
        );
        const waiting = yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
        expect(waiting.sessions.get(sessionId)!.session.backgroundTasks).toMatchObject([
          { id: "bg-task", kind },
        ]);
        const control = SessionId.make("s-control");
        yield* startWorking(driver, control);
        yield* idleTimeoutElapsed(driver, control, 1);
        expect(harness.closed).toBe(false);
        const autoId = TurnId.make("auto-background");

        const trigger = TurnTrigger.cases.BackgroundTasksReported.make({
          tasks: [{ id: "bg-task", kind }],
        });

        harness.emit(
          HarnessEvent.BackgroundTasksChanged({ tasks: [] }),
          ...(kind === "subagent"
            ? [
                HarnessEvent.SubagentEnded({
                  subagentId: SUB,
                  status: "completed",
                  report: "**report**",
                }),
              ]
            : []),
          HarnessEvent.TurnStarted({ turnId: autoId, prompt: null, trigger }),
          HarnessEvent.ItemCompleted({
            turnId: autoId,
            item: TurnItem.cases.AssistantMessage.make({
              id: "continued",
              text: "I have the report.",
            }),
          })
        );

        const working = yield* waitFor(
          (m) => m.sessions.get(sessionId)?.turns.at(-1)?.id === autoId
        );

        expect(working.sessions.get(sessionId)!.session.state).toBe("working");
        // Waiting ended while Idle, which armed the idle timer; the continuation cancels it.
        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId: control, prompt: "again", attachments: [] })
        );
        yield* idleTimeoutElapsed(driver, control, 2);
        expect(harness.closed).toBe(false);
        harness.emit(HarnessEvent.TurnEnded({ turnId: autoId, status: "completed", error: null }));
        yield* waitFor((m) => m.sessions.get(sessionId)?.turns.at(-1)?.status === "completed");
        yield* waitUntil(() => tags(stream.items).filter((t) => t === "TurnEnded").length === 2);
        yield* stream.stop;

        const events = stream.items.flatMap((i) =>
          Predicate.isTagged(i, "Event") ? [i.envelope.event] : []
        );

        const startIndex = events.findIndex(
          (e) => DomainEvent.guards.TurnStarted(e) && e.turn.id === autoId
        );

        const itemIndex = events.findIndex(
          (e) => DomainEvent.guards.TurnItemCompleted(e) && e.turnId === autoId
        );

        expect(startIndex).toBeGreaterThan(-1);
        expect(itemIndex).toBeGreaterThan(startIndex);

        if (kind === "subagent")
          expect(events.find(DomainEvent.guards.SubagentEnded)?.subagent.report).toBe("**report**");
        expect(
          events.filter(DomainEvent.guards.SessionBackgroundTasksChanged).map((e) => e.tasks.length)
        ).toEqual([1, 0]);
        const snapshot = yield* collect(sessionId, true);
        yield* snapshot.stop;
        const first = snapshot.items[0];

        if (!Predicate.isTagged(first, "Snapshot")) throw new Error("expected snapshot");

        if (kind === "subagent")
          expect(first.turns[0]!.subagents[0]!.subagent.report).toBe("**report**");
        expect(first.session.backgroundTasks).toEqual([]);
        expect(first.turns[1]!.turn).toMatchObject({
          prompt: "[Background task continuation]",
          trigger,
          status: "completed",
        });
      })
    );
  }
);

test.each([false, true])(
  "user/autonomous race (native first=%s) records one merged Turn",
  async (nativeFirst) => {
    const autoId = TurnId.make("native-race");
    const trigger = TurnTrigger.cases.BackgroundTasksReported.make({ tasks: [] });

    const driver = makeFakeDriver("codex", {
      onTurn: (input, session) =>
        session.turns.length === 1
          ? []
          : [
              ...(!nativeFirst
                ? [HarnessEvent.TurnStarted({ turnId: autoId, prompt: null, trigger })]
                : []),
              HarnessEvent.ItemDelta({
                turnId: autoId,
                itemId: "reply",
                field: "text",
                text: "Merged",
              }),
              HarnessEvent.ItemCompleted({
                turnId: autoId,
                item: TurnItem.cases.AssistantMessage.make({ id: "reply", text: "Merged" }),
              }),
              HarnessEvent.TurnEnded({ turnId: autoId, status: "completed", error: null }),
            ],
    });

    await run(
      layerWith(driver),
      Effect.gen(function* () {
        const sessionId = SessionId.make("race");
        const initial = yield* startWorking(driver, sessionId);
        const harness = driver.latest(sessionId)!;
        harness.emit(HarnessEvent.TurnEnded({ turnId: initial, status: "completed", error: null }));
        yield* waitFor((model) => model.sessions.get(sessionId)?.session.state === "idle");

        if (nativeFirst) {
          harness.emit(HarnessEvent.TurnStarted({ turnId: autoId, prompt: null, trigger }));
          yield* waitFor(
            (model) =>
              model.sessions.get(sessionId)?.turns.some((turn) => turn.id === autoId) === true
          );
        }

        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId, prompt: "User raced", attachments: [] })
        );

        const model = yield* waitFor(
          (model) =>
            model.sessions.get(sessionId)?.session.state === "idle" &&
            model.sessions.get(sessionId)?.turns.length === 2
        );

        const record = model.sessions.get(sessionId)!;
        expect(record.turns[1]!.status).toBe("completed");
        expect(harness.turns[1]?.prompt).toBe("User raced");
        const store = yield* EventStore;
        const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId });

        const reply = events.find((envelope) =>
          DomainEvent.guards.TurnItemCompleted(envelope.event)
        );

        expect(reply?.event).toMatchObject({
          turnId: record.turns[1]!.id,
          item: { text: "Merged" },
        });
      })
    );
  }
);

test("background inactivity cap re-arms on streamed work, stops the Harness and records its reason", async () => {
  const driver = makeFakeDriver("codex");
  await run(
    engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [driver],
      idleTimeout: Duration.millis(10),
      backgroundIdleTimeout: Duration.millis(100),
    }),
    Effect.gen(function* () {
      const sessionId = SessionId.make("cap");
      const turnId = yield* startWorking(driver, sessionId);
      const harness = driver.latest(sessionId)!;
      harness.emit(
        HarnessEvent.BackgroundTasksChanged({
          tasks: [new BackgroundTask({ id: "build", kind: "command", description: "Build" })],
        }),
        HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
      );
      yield* waitFor((model) => model.sessions.get(sessionId)?.session.state === "idle");
      yield* Effect.sleep(Duration.millis(60));
      harness.emit(
        HarnessEvent.ItemDelta({
          turnId,
          itemId: "background-progress",
          field: "text",
          text: "Still running",
        })
      );
      yield* Effect.sleep(Duration.millis(60));
      expect(harness.closed).toBe(false);

      const model = yield* waitFor(
        (model) => model.sessions.get(sessionId)?.session.state === "dormant"
      );

      yield* waitUntil(() => harness.closed);
      expect(model.sessions.get(sessionId)!.session.backgroundTasks).toEqual([]);
      const store = yield* EventStore;
      const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId });
      expect(
        events.some(
          (envelope) =>
            DomainEvent.guards.SessionStateChanged(envelope.event) &&
            envelope.event.reason === "background-idle-timeout"
        )
      ).toBe(true);
    })
  );
});

test("the final background level cannot re-arm the longer timer after waiting ends", async () => {
  const driver = makeFakeDriver("codex");
  await run(
    engineLayer({
      filename: join(tempDir(), "state.sqlite"),
      fakes: makeFakes(),
      drivers: [driver],
      idleTimeout: Duration.millis(30),
      backgroundIdleTimeout: Duration.seconds(5),
    }),
    Effect.gen(function* () {
      const sessionId = SessionId.make("waiting-ended");
      const turnId = yield* startWorking(driver, sessionId);
      const harness = driver.latest(sessionId)!;
      harness.emit(
        HarnessEvent.BackgroundTasksChanged({
          tasks: [new BackgroundTask({ id: "build", kind: "command", description: "Build" })],
        }),
        HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
      );
      yield* waitFor((model) => model.sessions.get(sessionId)?.session.state === "idle");
      harness.emit(HarnessEvent.BackgroundTasksChanged({ tasks: [] }));

      const model = yield* waitFor(
        (model) => model.sessions.get(sessionId)?.session.state === "dormant"
      );

      yield* waitUntil(() => harness.closed);
      const store = yield* EventStore;
      const events = yield* store.readEvents({ after: 0, upTo: model.sequence, sessionId });
      expect(
        events.some(
          (envelope) =>
            DomainEvent.guards.SessionStateChanged(envelope.event) &&
            envelope.event.reason === "idle-timeout"
        )
      ).toBe(true);
    })
  );
});

test.each([false, true])(
  "accepted input survives autonomous completion during preparation (queued=%s)",
  async (queued) => {
    const driver = makeFakeDriver("codex");

    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const autoId = TurnId.make("native-delivery-race");

    const checkpoints = Layer.succeed(Checkpoints)({
      capture: ({ turnId, label }) =>
        turnId === autoId && label === "before"
          ? Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(null)
            )
          : Effect.succeed(null),
    });

    await run(
      engineLayer({
        filename: join(tempDir(), "state.sqlite"),
        fakes: makeFakes(),
        drivers: [driver],
        checkpoints,
      }),
      Effect.gen(function* () {
        const sessionId = SessionId.make("late-delivery");
        const initial = yield* startWorking(driver, sessionId);
        const harness = driver.latest(sessionId)!;
        harness.emit(HarnessEvent.TurnEnded({ turnId: initial, status: "completed", error: null }));
        yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
        harness.emit(
          HarnessEvent.TurnStarted({
            turnId: autoId,
            prompt: null,
            trigger: TurnTrigger.cases.BackgroundTasksReported.make({
              tasks: [{ id: "build", kind: "command" }],
            }),
          })
        );
        yield* waitFor(
          (m) => m.sessions.get(sessionId)?.turns.some((t) => t.id === autoId) === true
        );
        yield* dispatch(
          Command.cases.SendTurn.make({ sessionId, prompt: "Hold", attachments: [] })
        );
        yield* Deferred.await(entered);

        if (queued)
          yield* dispatch(
            Command.cases.SendTurn.make({ sessionId, prompt: "Queued", attachments: [] })
          );
        harness.emit(HarnessEvent.TurnEnded({ turnId: autoId, status: "completed", error: null }));
        yield* waitFor(
          (m) =>
            m.sessions.get(sessionId)?.turns.find((t) => t.id === autoId)?.status === "completed"
        );
        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(() => harness.turns.length === 2);
        expect(harness.turns[1]!.prompt).toBe("Hold");
        yield* Effect.sleep(Duration.millis(20));
        expect(harness.turns).toHaveLength(2);
        harness.emit(
          HarnessEvent.TurnEnded({
            turnId: harness.turns[1]!.turnId,
            status: "completed",
            error: null,
          })
        );

        if (queued) {
          yield* waitUntil(() => harness.turns.length === 3);
          expect(harness.turns[2]!.prompt).toBe("Queued");
          harness.emit(
            HarnessEvent.TurnEnded({
              turnId: harness.turns[2]!.turnId,
              status: "completed",
              error: null,
            })
          );
        }

        const model = yield* waitFor(
          (m) =>
            m.sessions.get(sessionId)?.session.state === "idle" &&
            m.sessions.get(sessionId)?.turns.length === (queued ? 4 : 3)
        );

        const turns = model.sessions.get(sessionId)!.turns;
        expect(turns.slice(2).map((t) => t.prompt)).toEqual(queued ? ["Hold", "Queued"] : ["Hold"]);
        expect(
          turns
            .slice(2)
            .every((t) => t.trigger === null && t.status === "completed" && t.id !== autoId)
        ).toBe(true);
        expect(harness.turns.map((t) => t.prompt)).toEqual(
          queued ? ["go", "Hold", "Queued"] : ["go", "Hold"]
        );
        expect(new Set(harness.turns.map((t) => t.turnId)).size).toBe(harness.turns.length);
      }).pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.ensuring(Deferred.succeed(release, undefined))
      )
    );
  }
);

test("background progress updates one sleeping timer and expiry sleeps only the remainder", async () => {
  const clock = Effect.runSync(Clock.Clock);
  const sleeps: Array<number> = [];

  const timedClock: Clock.Clock = {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) => {
      sleeps.push(Duration.toMillis(duration));

      return clock.sleep(duration);
    },
  };

  const driver = makeFakeDriver("codex");

  const layer = engineLayer({
    filename: join(tempDir(), "state.sqlite"),
    fakes: makeFakes(),
    drivers: [driver],
    backgroundIdleTimeout: Duration.millis(200),
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const sessionId = SessionId.make("single-timer");
      const turnId = yield* startWorking(driver, sessionId);
      const harness = driver.latest(sessionId)!;
      harness.emit(
        HarnessEvent.BackgroundTasksChanged({
          tasks: [new BackgroundTask({ id: "build", kind: "command", description: "Build" })],
        }),
        HarnessEvent.TurnEnded({ turnId, status: "completed", error: null })
      );
      yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "idle");
      yield* Effect.sleep(Duration.millis(60));

      for (let i = 0; i < 20; i++)
        harness.emit(
          HarnessEvent.ItemDelta({
            turnId,
            itemId: "progress",
            field: "text",
            text: "Still running",
          })
        );
      yield* Effect.sleep(Duration.millis(60));
      expect(sleeps.filter((ms) => ms === 200)).toHaveLength(1);
      yield* waitFor((m) => m.sessions.get(sessionId)?.session.state === "dormant");
      expect(sleeps.some((ms) => ms > 0 && ms < 200)).toBe(true);
      yield* waitUntil(() => harness.closed);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, timedClock))
  );
});
