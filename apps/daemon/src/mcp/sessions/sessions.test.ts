import { expect, test } from "bun:test";
import { BackgroundTask, CommandId, DomainEvent, SessionId, TurnItem } from "@polaris/protocol";
import { Effect, Fiber, Predicate } from "effect";
import { finish, send, session, signal, WORKER } from "../../constellation/delivery/testing.ts";
import { EventStore, LiveItem } from "../../store/EventStore.ts";
import { NotifyOutcome, WaitOutcome, sessionTools, TRANSCRIPT_LIMIT } from "./index.ts";
import { notifier, NOTIFY_INTERVAL_MS } from "./notify.ts";

const run = <A, E>(effect: Effect.Effect<A, E, EventStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(EventStore.layerSqlite(":memory:"))));

const created = Effect.gen(function* () {
  const store = yield* EventStore;
  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([DomainEvent.cases.SessionCreated.make({ session: session(WORKER) })]),
  });

  return store;
});

const item = Effect.fnUntraced(function* (sessionId: SessionId, value: TurnItem) {
  const store = yield* EventStore;
  const turn = (yield* store.model).sessions.get(sessionId)!.turns.at(-1)!;
  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.TurnItemCompleted.make({
          sessionId,
          turnId: turn.id,
          item: value,
          subagentId: null,
        }),
      ]),
  });
});

const command = (id: string, output: string) =>
  TurnItem.cases.CommandExecution.make({
    id,
    startedAt: null,
    command: "bun test",
    cwd: "/tmp",
    output,
    exitCode: 0,
    status: "completed",
  });

const tasks = (...ids: ReadonlyArray<string>) =>
  signal(WORKER, {
    type: "harness.backgroundTasksChanged",
    tasks: ids.map((id) => new BackgroundTask({ id, kind: "command", description: `run ${id}` })),
  });

test("a transcript lists the latest Turns with replies, commands and their output tails", async () => {
  const text = await run(
    Effect.gen(function* () {
      const store = yield* created;
      yield* send(WORKER, "Fix the parser");
      yield* item(
        WORKER,
        TurnItem.cases.AssistantMessage.make({ id: "a1", text: "Looking.", startedAt: null })
      );
      yield* item(
        WORKER,
        command("c1", Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\n"))
      );
      yield* finish(WORKER);
      yield* send(WORKER, "Now the tests");

      return yield* sessionTools(store).transcript(WORKER, { turns: 2, since: null });
    })
  );

  expect(text).toContain("## Turn 1 · completed");
  expect(text).toContain("Prompt: Fix the parser");
  expect(text).toContain("Assistant: Looking.");
  expect(text).toContain("$ bun test (exit 0)");
  expect(text).toContain("line 29");
  expect(text).not.toContain("line 3\n");
  expect(text).toContain("## Turn 2 · working");
});

test("since pages back; turns bounds the count; an unknown session is null", async () => {
  const [paged, latest, missing] = await run(
    Effect.gen(function* () {
      const store = yield* created;

      for (const prompt of ["one", "two", "three"]) {
        yield* send(WORKER, prompt);
        yield* finish(WORKER);
      }

      const tools = sessionTools(store);

      return [
        yield* tools.transcript(WORKER, { turns: 1, since: 2 }),
        yield* tools.transcript(WORKER, { turns: 1, since: null }),
        yield* tools.transcript(SessionId.make("nobody"), { turns: 1, since: null }),
      ] as const;
    })
  );

  expect(paged).toContain("Prompt: two");
  expect(paged).not.toContain("Prompt: three");
  expect(latest).toContain("Prompt: three");
  expect(latest).not.toContain("Prompt: two");
  expect(missing).toBeNull();
});

test("a long transcript stays within its budget, newest Turn first to keep", async () => {
  const text = await run(
    Effect.gen(function* () {
      const store = yield* created;

      for (const n of [1, 2, 3]) {
        yield* send(WORKER, `turn ${n}`);

        for (const m of Array.from({ length: 12 }, (_, i) => i))
          yield* item(
            WORKER,
            TurnItem.cases.AssistantMessage.make({
              id: `a${n}-${m}`,
              text: "x".repeat(1_900),
              startedAt: null,
            })
          );
        yield* finish(WORKER);
      }

      return (yield* sessionTools(store).transcript(WORKER, { turns: 3, since: null })) ?? "";
    })
  );

  expect(text.length).toBeLessThan(TRANSCRIPT_LIMIT * 1.2);
  expect(text).toContain("Prompt: turn 3");
  expect(text).toContain("left out (too long)");
});

test("waiting returns when the watched background command finishes, with its output", async () => {
  const outcome = await run(
    Effect.gen(function* () {
      const store = yield* created;
      yield* send(WORKER);
      yield* signal(WORKER, { type: "harness.opened" });
      yield* tasks("c1", "c2");

      const waiting = yield* Effect.forkChild(
        sessionTools(store).waitForCommand(WORKER, { task: "c1", timeoutMs: 5_000 })
      );

      yield* Effect.sleep(20);
      yield* item(WORKER, command("c1", "12 pass"));
      yield* tasks("c2");

      return yield* Fiber.join(waiting);
    })
  );

  const finished = WaitOutcome.$is("Finished")(outcome) ? outcome.finished : [];
  expect(finished.map((f) => f.task.id)).toEqual(["c1"]);
  expect(finished[0]?.command?.output).toBe("12 pass");
});

test("waiting for a command skips Deltas and unrelated Session events", () =>
  run(
    Effect.gen(function* () {
      const store = yield* created;
      yield* send(WORKER);
      yield* signal(WORKER, { type: "harness.opened" });
      yield* tasks("c1");
      const turnId = (yield* store.model).sessions.get(WORKER)!.turns.at(-1)!.id;
      let reads = 0;

      const waiting = yield* Effect.forkChild(
        sessionTools({
          ...store,
          model: Effect.tap(store.model, () => Effect.sync(() => reads++)),
        }).waitForCommand(WORKER, { task: "c1", timeoutMs: 1000 })
      );

      yield* Effect.sleep(10);

      for (let n = 0; n < 64; n++)
        yield* store.publishEphemeral(
          LiveItem.Delta({
            sessionId: WORKER,
            turnId,
            itemId: "streaming-message",
            field: "text",
            text: "delta",
            subagentId: null,
          })
        );

      yield* item(WORKER, command("c1", "12 pass"));
      yield* Effect.sleep(10);
      expect(reads).toBe(1);
      yield* tasks();
      const result = yield* Fiber.join(waiting);
      expect(
        WaitOutcome.$is("Finished")(result) ? result.finished.map((entry) => entry.task.id) : []
      ).toEqual(["c1"]);
    })
  ));

test("waiting times out with what still runs, and is idle when nothing runs", async () => {
  const [running, idle, missing] = await run(
    Effect.gen(function* () {
      const store = yield* created;
      yield* send(WORKER);
      yield* signal(WORKER, { type: "harness.opened" });
      const tools = sessionTools(store);
      const none = yield* tools.waitForCommand(WORKER, { task: null, timeoutMs: 10 });
      yield* tasks("c1");

      return [
        yield* tools.waitForCommand(WORKER, { task: null, timeoutMs: 30 }),
        none,
        yield* tools.waitForCommand(WORKER, { task: "gone", timeoutMs: 10 }),
      ] as const;
    })
  );

  expect(running).toEqual(
    WaitOutcome.Running({
      running: [new BackgroundTask({ id: "c1", kind: "command", description: "run c1" })],
    })
  );
  expect(idle).toEqual(WaitOutcome.Idle({ task: null }));
  expect(missing).toEqual(WaitOutcome.Idle({ task: "gone" }));
});

test("notify records SessionNotified once per id, at most once per interval per session", async () => {
  let now = 1_000_000;

  const [outcomes, notified] = await run(
    Effect.gen(function* () {
      const store = yield* created;
      const { notify } = notifier(store, () => now);
      const input = { title: "Done", body: "All green" };

      const first = yield* notify(WORKER, input, CommandId.make("n1"));
      const retry = yield* notify(WORKER, input, CommandId.make("n1"));
      const soon = yield* notify(WORKER, input, CommandId.make("n2"));
      now += NOTIFY_INTERVAL_MS;
      const later = yield* notify(WORKER, input, CommandId.make("n3"));
      const nobody = yield* notify(SessionId.make("nobody"), input, CommandId.make("n4"));
      const model = yield* store.model;

      const events = yield* store.readEvents({
        after: 0,
        upTo: model.sequence,
        sessionId: WORKER,
        eventTypes: ["SessionNotified"],
      });

      return [[first, retry, soon, later, nobody], events] as const;
    })
  );

  expect(outcomes).toEqual([
    NotifyOutcome.Sent(),
    NotifyOutcome.AlreadySent(),
    NotifyOutcome.RateLimited({ retryInSeconds: 30 }),
    NotifyOutcome.Sent(),
    NotifyOutcome.NotFound(),
  ]);
  expect(notified.map((e) => `${e.commandId ?? ""} ${e.event._tag}`)).toEqual([
    "n1 SessionNotified",
    "n3 SessionNotified",
  ]);
});

test("an automatic notification is sent once per cause, and the agent's notify after it collapses", async () => {
  let now = 1_000_000;

  const [outcomes, notified] = await run(
    Effect.gen(function* () {
      const store = yield* created;
      const notifications = notifier(store, () => now);

      const question = {
        sessionId: WORKER,
        constellationId: "c1",
        about: [],
        id: "attention:c1:question:a1:base",
        title: "A1 asks you",
        body: "Which base should I use?",
      };

      const first = yield* notifications.automatic(question);
      const again = yield* notifications.automatic(question);

      // The same worker asking again at once waits out the interval.
      const flood = yield* notifications.automatic({
        ...question,
        id: "attention:c1:question:a1:2",
      });

      now += 1_000;

      const echo = yield* notifications.notify(
        WORKER,
        { title: "I asked you", body: "" },
        CommandId.make("n1")
      );

      now += NOTIFY_INTERVAL_MS;

      const later = yield* notifications.notify(
        WORKER,
        { title: "Done", body: "" },
        CommandId.make("n2")
      );

      const waited = yield* notifications.automatic({
        ...question,
        id: "attention:c1:question:a1:2",
      });

      const model = yield* store.model;

      const events = yield* store.readEvents({
        after: 0,
        upTo: model.sequence,
        sessionId: WORKER,
        eventTypes: ["SessionNotified"],
      });

      return [[first, again, flood, echo, later, waited], events] as const;
    })
  );

  expect(outcomes).toEqual([
    "Done",
    "Done",
    "Limited",
    NotifyOutcome.Collapsed(),
    NotifyOutcome.Sent(),
    "Done",
  ]);
  expect(
    notified.map((e) =>
      Predicate.isTagged(e.event, "SessionNotified")
        ? [
            e.event.notification.title,
            e.event.notification.automatic,
            e.event.notification.constellationId,
          ]
        : null
    )
  ).toEqual([
    ["A1 asks you", true, "c1"],
    ["Done", false, null],
    ["A1 asks you", true, "c1"],
  ]);
});
