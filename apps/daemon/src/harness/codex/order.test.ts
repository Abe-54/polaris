/**
 * What a long command does to a Codex Turn, against a fake app-server: items keep
 * the order they started, a steer lands only when the model reads it, and a command
 * the model moved on from is a background task until it completes.
 */
import { afterEach, expect, test } from "bun:test";
import { BackgroundTask, inStartOrder, TurnItem } from "@polaris/protocol";
import { Effect } from "effect";
import { HarnessEvent } from "../HarnessDriver.ts";
import { makeCodexDriver } from "./CodexDriver.ts";
import type { Json } from "./protocol.ts";
import type { FakeConnection, Handler } from "./testing/FakeAppServer.ts";
import {
  cleanup,
  type Harness,
  ofTag,
  scripted,
  sessionWith,
  THREAD,
  turn,
} from "./testing/session.ts";

const withSession = sessionWith(makeCodexDriver);

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const T = "t_tui";

/** A notification as app-server sends it, before its thread and turn are added. */
type Params = { readonly [key: string]: Json };

type Send = (method: string, params: Params) => void;

const commandItem = (id: string, status: "inProgress" | "completed") => ({
  type: "commandExecution",
  id,
  command: id,
  cwd: "/repo",
  status,
  aggregatedOutput: status === "completed" ? "ok" : null,
  exitCode: status === "completed" ? 0 : null,
  processId: `pid-${id}`,
});

const messageItem = (id: string) => ({ type: "agentMessage", id, text: "done", phase: null });

const userMessage = (id: string, text: string) => ({
  type: "userMessage",
  id,
  clientId: null,
  content: [{ type: "text", text, text_elements: [] }],
});

const started = (send: Send, item: Params) => send("item/started", { startedAtMs: 0, item });

const completed = (send: Send, item: Params) => send("item/completed", { completedAtMs: 0, item });

/** A session rejoining a thread, where Codex is running a Turn started in the TUI. */
const rejoin = (drive: (send: Send, h: Harness) => Effect.Effect<void, unknown>) => {
  let conn: FakeConnection | null = null;

  const handler: Handler = (request, c) => {
    if (request.method === "thread/resume") conn = c;

    if (request.method === "turn/steer") return c.reply({ turnId: T });

    if (request.method === "thread/backgroundTerminals/terminate")
      return c.reply({ terminated: true });

    return scripted(() => {})(request, c);
  };

  const send: Send = (method, params) =>
    conn?.notify(method, { threadId: THREAD, turnId: T, ...params });

  // Waits for the session to see the command, not a fixed sleep a slow runner can outlast.
  const begin = (h: Harness) =>
    Effect.gen(function* () {
      send("turn/started", { turn: turn(T) });
      started(send, userMessage("u1", "sleep, then answer"));
      started(send, commandItem("sleep", "inProgress"));
      yield* h.waitFor("ItemUpdated", (e) => e.item.id === "sleep");
    });

  return withSession(handler, (h) => begin(h).pipe(Effect.andThen(drive(send, h))), {
    resumeCursor: THREAD,
  });
};

const pause = Effect.sleep("10 millis");

const userMessages = (events: ReadonlyArray<HarnessEvent>) =>
  ofTag(events, "ItemCompleted").flatMap((e) => (TurnItem.guards.UserMessage(e.item) ? [e] : []));

test("a long command completed last still reads where it started", async () => {
  const { stamped } = await rejoin((send) =>
    Effect.gen(function* () {
      started(send, commandItem("quick", "inProgress"));
      completed(send, commandItem("quick", "completed"));
      yield* pause;
      completed(send, commandItem("sleep", "completed"));
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
    })
  );

  const items = ofTag(stamped, "ItemCompleted").map((e) => e.item);
  expect(items.map((i) => i.id)).toEqual(["quick", "sleep"]);
  expect(inStartOrder(items).map((i) => i.id)).toEqual(["sleep", "quick"]);
});

test("a steer stays pending while a command blocks the model, and lands before its reply", async () => {
  const seen = { whileBlocked: -1 };

  const { events } = await rejoin((send, { session, events }) =>
    Effect.gen(function* () {
      yield* session.steer("also say banana");
      started(send, userMessage("u2", "also say banana"));
      yield* pause;
      seen.whileBlocked = userMessages(events).length;
      completed(send, commandItem("sleep", "completed"));
      started(send, messageItem("m1"));
      completed(send, messageItem("m1"));
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
    })
  );

  expect(seen.whileBlocked).toBe(0);
  expect(userMessages(events).map((e) => e.item)).toEqual([
    TurnItem.cases.UserMessage.make({ id: "steer:t_tui:1", text: "also say banana" }),
  ]);
  const tags = ofTag(events, "ItemCompleted").map((e) => e.item.id);
  expect(tags).toEqual(["sleep", "steer:t_tui:1", "m1"]);
});

test("a steer the model never got to before the Turn ended lands with the end", async () => {
  const { events } = await rejoin((send, { session }) =>
    Effect.gen(function* () {
      yield* session.steer("also say banana");
      yield* pause;
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
    })
  );

  expect(userMessages(events)).toHaveLength(1);
  expect(events.findIndex(HarnessEvent.$is("TurnEnded"))).toBeGreaterThan(
    events.findIndex((e) => userMessages([e]).length === 1)
  );
});

test("a command the model moved on from is a background task until Codex completes it", async () => {
  const sleepTask = new BackgroundTask({ id: "sleep", kind: "command", description: "sleep" });

  const { events } = await rejoin((send) =>
    Effect.gen(function* () {
      started(send, messageItem("m1"));
      completed(send, messageItem("m1"));
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
      completed(send, commandItem("sleep", "completed"));
      yield* pause;
    })
  );

  expect(ofTag(events, "BackgroundTasksChanged").map((e) => e.tasks)).toEqual([[sleepTask], []]);

  const order = events
    .filter(
      (e) => HarnessEvent.$is("BackgroundTasksChanged")(e) || HarnessEvent.$is("TurnEnded")(e)
    )
    .map((e) => e._tag);

  expect(order).toEqual(["BackgroundTasksChanged", "TurnEnded", "BackgroundTasksChanged"]);
});

test("a command that finishes before the model moves on is never a background task", async () => {
  const { events } = await rejoin((send) =>
    Effect.gen(function* () {
      completed(send, commandItem("sleep", "completed"));
      started(send, messageItem("m1"));
      completed(send, messageItem("m1"));
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
    })
  );

  expect(ofTag(events, "BackgroundTasksChanged")).toEqual([]);
});

test("stopping a background command terminates its process over an experimental connection", async () => {
  const { server } = await rejoin((send, { session }) =>
    Effect.gen(function* () {
      send("turn/completed", { turn: turn(T, "completed") });
      yield* pause;
      yield* session.stopBackground!(["sleep", "unknown"]);
    })
  );

  const initializes = server.requests("initialize").map((r) => r.params);
  expect(initializes.at(-1)).toMatchObject({ capabilities: { experimentalApi: true } });
  expect(initializes[0]).toMatchObject({ capabilities: { experimentalApi: false } });
  expect(server.requests("thread/backgroundTerminals/terminate").map((r) => r.params)).toEqual([
    { threadId: THREAD, processId: "pid-sleep" },
  ]);
});
