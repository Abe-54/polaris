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

type Told = Array<[string, boolean | null]>;

/** Polls until everything told matches; the deadline only decides how long a broken watch fails. */
const toldBecomes = (told: Told, expected: Told) =>
  Effect.promise(async () => {
    const start = performance.now();

    while (!Bun.deepEquals(told, expected) && performance.now() - start < 4000) await Bun.sleep(1);

    expect(told).toEqual(expected);
  });

test("each Host's value follows its watch, and is forgotten when it disconnects or is removed", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const modes = makeHostDeveloperModes();
      const told: Told = [];
      modes.subscribe((hostKey, m) => told.push([hostKey, m === null ? null : m.stored]));

      const sessions = yield* Queue.unbounded<WatchSession | null>();
      const fiber = yield* Effect.forkChild(modes.watch("studio", Stream.fromQueue(sessions)));

      yield* Queue.offer(sessions, host([mode(false), mode(true)]));
      yield* toldBecomes(told, [
        ["studio", false],
        ["studio", true],
      ]);
      expect(modes.current("studio")?.stored).toBe(true);
      expect(modes.all()).toEqual(new Map([["studio", mode(true)]]));

      yield* Queue.offer(sessions, null);
      yield* toldBecomes(told, [
        ["studio", false],
        ["studio", true],
        ["studio", null],
      ]);
      expect(modes.current("studio")).toBeNull();

      yield* Queue.offer(sessions, host([mode(false)]));
      yield* toldBecomes(told, [
        ["studio", false],
        ["studio", true],
        ["studio", null],
        ["studio", false],
      ]);
      expect(modes.current("studio")?.stored).toBe(false);

      // Interrupting waits for the watch to end, so nothing can still be told after this.
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

test("a connection to an older Daemon has no watch, so nothing is known about it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const modes = makeHostDeveloperModes();
      const told: Told = [];
      modes.subscribe((hostKey, m) => told.push([hostKey, m === null ? null : m.stored]));

      // An open watch never ends, so finishing proves none was left running.
      yield* modes.watch("studio", Stream.make(host([mode(true)], false)));

      expect(modes.current("studio")).toBeNull();
      expect(told).toEqual([]);
    })
  ));
