import { expect, test } from "bun:test";
import { DEFAULT_DEVELOPER_MODE } from "@polaris/protocol";
import { type Cause, Effect, Fiber, Queue, Stream } from "effect";
import { holdDeveloperModeLease, type LeaseSession } from "./lease.ts";

interface Leases {
  readonly held: Set<string>;
  readonly opened: Array<string>;
}

const makeLeases = (): Leases => ({ held: new Set(), opened: [] });

/** A fake Host connection whose lease is open exactly while its stream runs. */
const host = (leases: Leases, name: string, capable = true): LeaseSession => ({
  capabilities: capable ? ["developer-mode"] : [],
  client: {
    "developerMode.lease": () =>
      Stream.concat(Stream.succeed(DEFAULT_DEVELOPER_MODE), Stream.never).pipe(
        Stream.onStart(
          Effect.sync(() => {
            leases.opened.push(name);
            leases.held.add(name);
          })
        ),
        Stream.ensuring(Effect.sync(() => leases.held.delete(name)))
      ),
  },
});

/** Polls until the held leases match; the deadline only decides how long a broken lease fails. */
const heldBecomes = (leases: Leases, expected: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const start = performance.now();

    while (!Bun.deepEquals([...leases.held], expected) && performance.now() - start < 4000)
      await Bun.sleep(1);

    expect([...leases.held]).toEqual([...expected]);
  });

test("Polaris Dev holds one lease per live connection, and lets it go when the connection does", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const leases = makeLeases();
      const sessions = yield* Queue.unbounded<LeaseSession | null, Cause.Done>();
      const fiber = yield* Effect.forkChild(holdDeveloperModeLease(Stream.fromQueue(sessions)));

      yield* Queue.offer(sessions, host(leases, "first"));
      yield* heldBecomes(leases, ["first"]);

      // A reconnect to an older Daemon: the old lease is gone with its connection.
      yield* Queue.offer(sessions, host(leases, "older", false));
      yield* heldBecomes(leases, []);

      yield* Queue.offer(sessions, host(leases, "second"));
      yield* heldBecomes(leases, ["second"]);

      yield* Queue.offer(sessions, null);
      yield* heldBecomes(leases, []);

      // Holding ends only once every lease has, so nothing can still open after this.
      yield* Queue.end(sessions);
      yield* Fiber.join(fiber);
      expect(leases.opened).toEqual(["first", "second"]);
    })
  ));

test("a connection to an older Daemon takes no lease", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const leases = makeLeases();

      // An open lease never ends, so finishing proves none was left running.
      yield* holdDeveloperModeLease(Stream.make(host(leases, "older", false)));

      expect(leases.opened).toEqual([]);
    })
  ));
