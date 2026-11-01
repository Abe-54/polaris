import { expect, test } from "bun:test";
import { DEFAULT_DEVELOPER_MODE } from "@polaris/protocol";
import { Effect, Fiber, Queue, Stream } from "effect";
import { holdDeveloperModeLease, type LeaseSession } from "./lease.ts";

/** A fake Host connection whose lease is open exactly while its stream runs. */
const host = (held: Set<string>, name: string, capable = true): LeaseSession => ({
  capabilities: capable ? ["developer-mode"] : [],
  client: {
    "developerMode.lease": () =>
      Stream.concat(Stream.succeed(DEFAULT_DEVELOPER_MODE), Stream.never).pipe(
        Stream.onStart(Effect.sync(() => held.add(name))),
        Stream.ensuring(Effect.sync(() => held.delete(name)))
      ),
  },
});

const settle = Effect.sleep("20 millis");

test("Polaris Dev holds one lease per live connection, and lets it go when the connection does", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const held = new Set<string>();
      const sessions = yield* Queue.unbounded<LeaseSession | null>();
      const fiber = yield* Effect.forkChild(holdDeveloperModeLease(Stream.fromQueue(sessions)));

      yield* Queue.offer(sessions, host(held, "first"));
      yield* settle;
      expect([...held]).toEqual(["first"]);

      // A reconnect to an older Daemon: no lease to hold, and the old one is gone with its connection.
      yield* Queue.offer(sessions, host(held, "older", false));
      yield* settle;
      expect([...held]).toEqual([]);

      yield* Queue.offer(sessions, host(held, "second"));
      yield* settle;
      expect([...held]).toEqual(["second"]);

      yield* Queue.offer(sessions, null);
      yield* settle;
      expect([...held]).toEqual([]);

      yield* Fiber.interrupt(fiber);
    })
  ));
