import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { SimulatorAttachItem } from "@polaris/protocol";
import { SessionId } from "@polaris/protocol";
import { Effect, Fiber, Stream } from "effect";
import { SimulatorHub, SimulatorHubLive } from "./hub.ts";
import { alive, fakeHost, OURS, until, USERS } from "./hub.testing.ts";

// The fake hub's waits (`until`) allow 10 s on a loaded run.
setDefaultTimeout(20_000);

const SESSION = SessionId.make("ses_simulator_test");

/** Runs `body` with the hub service and an open attach to `OURS`, collecting its items. */
const withAttach = (
  host: ReturnType<typeof fakeHost>,
  body: (
    hub: SimulatorHub["Service"],
    items: Array<SimulatorAttachItem>,
    detach: Effect.Effect<void>
  ) => Effect.Effect<void, unknown>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* SimulatorHub;
        const items: Array<SimulatorAttachItem> = [];

        const fiber = yield* hub.attach(SESSION, OURS).pipe(
          Stream.runForEach((item) => Effect.sync(() => items.push(item))),
          Effect.forkScoped
        );

        yield* Effect.promise(() => until(() => items.length === 1));
        yield* body(hub, items, Fiber.interrupt(fiber).pipe(Effect.asVoid));
      })
    ).pipe(Effect.provide(host.layer()))
  );

const pidOf = (hub: SimulatorHub["Service"]) =>
  SimulatorHubLive.testing.supervisorOf(hub)?.pid ?? null;

describe("SimulatorHub lifecycle", () => {
  test("idles out once detached, shutting down only the Simulators Polaris booted", async () => {
    const host = fakeHost(300);

    await withAttach(host, (hub, _items, detach) =>
      Effect.gen(function* () {
        yield* hub.boot(OURS);
        const pid = pidOf(hub);
        // Three wedge checks, 100 ms apart, outlast the 300 ms idle time.
        yield* Effect.promise(() =>
          until(() => host.log().filter((line) => line === "barrier").length >= 3)
        );
        expect(alive(pid)).toBe(true);

        yield* detach;
        yield* Effect.promise(() => until(() => host.log().includes(`term ${pid}`)));
        expect(host.log()).toContain(`shutdown ${OURS}`);
        expect(host.log()).not.toContain(`shutdown ${USERS}`);
        expect(host.booted(USERS)).toBe(true);
        expect(pidOf(hub)).toBeNull();
      })
    );
  });

  test("a Simulator an agent booted with no hub running is shut down at idle", async () => {
    const host = fakeHost(300);

    host.bootOutside(OURS);
    await Effect.runPromise(
      Effect.flatMap(SimulatorHub, (hub) =>
        Effect.gen(function* () {
          yield* hub.agentBooted(OURS);
          yield* Effect.promise(() => until(() => host.log().some((l) => l.startsWith("term "))));
        })
      ).pipe(Effect.provide(host.layer()))
    );

    expect(host.log()).toContain(`shutdown ${OURS}`);
    expect(host.log()).not.toContain(`shutdown ${USERS}`);
    expect(host.booted(OURS)).toBe(false);
  });

  test("the idle stop shuts down a Simulator Polaris booted while simctl lagged behind", async () => {
    const host = fakeHost(300);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* SimulatorHub;
          host.stale(true);
          yield* hub.boot(OURS);
          host.stale(false);
          const pid = pidOf(hub);

          yield* Effect.promise(() => until(() => host.log().includes(`term ${pid}`)));
          expect(host.log()).toContain(`shutdown ${OURS}`);
        })
      ).pipe(Effect.provide(host.layer()))
    );
  });

  test("a crashed hub restarts and every attach gets the new endpoint", async () => {
    const host = fakeHost(60_000);

    await withAttach(host, (hub, items) =>
      Effect.gen(function* () {
        const pid = pidOf(hub)!;
        process.kill(pid, "SIGKILL");
        yield* Effect.promise(() => until(() => items.length === 2));
        expect(items[1]!.token).not.toBe(items[0]!.token);
        expect(alive(pidOf(hub))).toBe(true);
        expect(pidOf(hub)).not.toBe(pid);
      })
    );
  });

  test("wedged input restarts the hub; simulator.restart does the same on demand", async () => {
    const host = fakeHost(60_000);

    await withAttach(host, (hub, items) =>
      Effect.gen(function* () {
        const wedged = pidOf(hub);
        host.wedge(true);
        yield* Effect.promise(() => until(() => items.length === 2));
        host.wedge(false);
        expect(host.log()).toContain(`term ${wedged}`);

        yield* hub.restart;
        yield* Effect.promise(() => until(() => items.length === 3));
        expect(new Set(items.map((item) => item.token)).size).toBe(3);
      })
    );
  });
});
