import { expect, test } from "bun:test";
import { DeveloperMode } from "@polaris/protocol";
import { Effect, Fiber, Queue, Stream } from "effect";
import { makeHostDeveloperModes, type WatchSession } from "./watch.ts";

const mode = (stored: boolean) =>
  DeveloperMode.make({
    stored,
    leases: 0,
    fromSource: false,
    effective: stored,
    polarisWorkspaceId: null,
    polarisWorkspaceSource: null,
  });

/** A fake Host connection whose watch sends `values` and then stays open. */
const host = (values: ReadonlyArray<DeveloperMode>, capable = true): WatchSession => ({
  capabilities: capable ? ["developer-mode"] : [],
  client: {
    "developerMode.watch": () => Stream.concat(Stream.fromIterable(values), Stream.never),
  },
});

const settle = Effect.sleep("20 millis");

test("each Host's value follows its watch, and is forgotten when it disconnects or is removed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const modes = makeHostDeveloperModes();
      const told: Array<[string, boolean | null]> = [];
      modes.subscribe((hostKey, m) => told.push([hostKey, m === null ? null : m.stored]));

      const sessions = yield* Queue.unbounded<WatchSession | null>();
      const fiber = yield* Effect.forkChild(modes.watch("studio", Stream.fromQueue(sessions)));

      yield* Queue.offer(sessions, host([mode(false), mode(true)]));
      yield* settle;
      expect(modes.current("studio")?.stored).toBe(true);
      expect(modes.all()).toEqual(new Map([["studio", mode(true)]]));

      yield* Queue.offer(sessions, null);
      yield* settle;
      expect(modes.current("studio")).toBeNull();

      // An older Daemon has no watch: nothing is known about it.
      yield* Queue.offer(sessions, host([], false));
      yield* settle;
      expect(modes.current("studio")).toBeNull();

      yield* Queue.offer(sessions, host([mode(false)]));
      yield* settle;
      yield* Fiber.interrupt(fiber);

      expect(modes.current("studio")).toBeNull();
      expect(told).toEqual([
        ["studio", false],
        ["studio", true],
        ["studio", null],
        ["studio", false],
        ["studio", null],
      ]);
    })
  ));
