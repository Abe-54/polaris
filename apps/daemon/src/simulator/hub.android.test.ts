/**
 * Android Emulators through the hub, on the fake hub (no emulator runs here; ENG-834 lists
 * what a real one still needs to prove).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect, Option, Predicate, Stream } from "effect";
import { SimulatorHub } from "./hub.ts";
import { EMULATOR, fakeHost, hubsStopped, OURS, until } from "./hub.testing.ts";

// The fake hub's waits (`until`) allow 10 s on a loaded run.
setDefaultTimeout(20_000);

const run = <A, E>(
  host: ReturnType<typeof fakeHost>,
  body: (hub: SimulatorHub["Service"]) => Effect.Effect<A, E>
) => Effect.runPromise(Effect.flatMap(SimulatorHub, body).pipe(Effect.provide(host.layer())));

/** What a fresh watch lists, as `id platform state`. */
const listed = (hub: SimulatorHub["Service"]) =>
  Effect.scoped(
    Effect.map(Stream.runHead(hub.watch), (head) => {
      const item = Option.getOrThrow(head);

      if (!Predicate.isTagged(item, "Snapshot")) throw new Error(`got ${item._tag}`);

      return item.simulators.map((s) => `${s.id} ${s.platform} ${s.state}`);
    })
  );

describe("Android Emulators through the hub", () => {
  test("listed from the running hub; boot and shutdown use its device routes, iOS serve-sim's", async () => {
    const host = fakeHost(60_000, { android: true });

    const seen = await run(host, (hub) =>
      Effect.gen(function* () {
        yield* hub.boot(OURS);
        const before = yield* listed(hub);
        yield* hub.boot(EMULATOR);
        const booted = yield* listed(hub);
        yield* hub.shutdown(EMULATOR, false);
        yield* hub.shutdown(OURS, false);

        return { before, booted };
      })
    );

    expect(seen.before).toContain(`${EMULATOR} android Shutdown`);
    expect(seen.booted).toContain(`${EMULATOR} android Booted`);
    expect(host.log().filter((line) => line.startsWith("route "))).toEqual([
      `route /api/devices/boot ${OURS}`,
      `route /api/devices/boot ${EMULATOR}`,
      `route /api/devices/shutdown ${EMULATOR}`,
      `route /vendor/serve-sim/grid/api/shutdown ${OURS}`,
    ]);
    expect(host.booted(EMULATOR)).toBe(false);
  });

  test("the idle stop shuts down an emulator Polaris booted", async () => {
    const host = fakeHost(300, { android: true });

    await run(host, (hub) =>
      Effect.gen(function* () {
        yield* hub.boot(OURS);
        yield* hub.boot(EMULATOR);
        yield* Effect.promise(() => until(() => hubsStopped(host.log())));
      })
    );

    expect(host.log()).toContain(`shutdown ${EMULATOR}`);
    expect(host.booted(EMULATOR)).toBe(false);
  });
});
