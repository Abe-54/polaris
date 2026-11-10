import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { SessionId, SimulatorSessionItem, type SimulatorWatchItem } from "@polaris/protocol";
import { Effect, Exit, Fiber, Option, Predicate, type Scope, Stream } from "effect";
import { SimulatorHub, SimulatorHubLive } from "./hub.ts";
import { fakeHost, OURS, until, USERS } from "./hub.testing.ts";

// The fake hub's waits (`until`) allow 10 s on a loaded run.
setDefaultTimeout(20_000);

const SESSION = SessionId.make("ses_simulator_test");

/** The Simulators in a watch's first item, which must be a `Snapshot`. */
const snapshotOf = (head: Option.Option<SimulatorWatchItem>) => {
  const item = Option.getOrThrow(head);

  if (!Predicate.isTagged(item, "Snapshot"))
    throw new Error(`expected a Snapshot, got ${item._tag}`);

  return item.simulators;
};

const run = <A, E>(
  host: ReturnType<typeof fakeHost>,
  body: (hub: SimulatorHub["Service"]) => Effect.Effect<A, E, Scope.Scope>,
  sessions?: Parameters<ReturnType<typeof fakeHost>["layer"]>[0]
) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(SimulatorHub, body)).pipe(Effect.provide(host.layer(sessions)))
  );

describe("SimulatorHub", () => {
  test("a watch lists the Host's Simulators without starting the hub", async () => {
    const host = fakeHost();

    const first = await run(host, (hub) =>
      Effect.gen(function* () {
        const head = yield* Stream.runHead(hub.watch);
        expect(SimulatorHubLive.testing.supervisorOf(hub)?.pid).toBeNull();

        return head;
      })
    );

    expect(snapshotOf(first).map((s) => [s.id, s.state])).toEqual([
      [OURS, "Shutdown"],
      [USERS, "Booted"],
    ]);
    expect(host.log()).toEqual([]);
  });

  test("shutdown refuses a Simulator Polaris didn't boot unless forced", async () => {
    const host = fakeHost();

    const refused = await run(host, (hub) => Effect.exit(hub.shutdown(USERS, false)));
    expect(Exit.isFailure(refused) && JSON.stringify(refused.cause)).toContain(
      "SimulatorNotBootedByPolaris"
    );
    expect(host.booted(USERS)).toBe(true);

    await run(host, (hub) => hub.shutdown(USERS, true));
    expect(host.booted(USERS)).toBe(false);
  });

  test("a Simulator Polaris booted stays bootedByPolaris across Daemon restarts", async () => {
    const host = fakeHost(60_000);
    await run(host, (hub) => hub.boot(OURS));

    const head = await run(host, (hub) => Stream.runHead(hub.watch));
    const simulators = snapshotOf(head);

    expect(simulators.find((s) => s.id === OURS)?.bootedByPolaris).toBe(true);
    expect(simulators.find((s) => s.id === USERS)?.bootedByPolaris).toBe(false);
  });

  test("attach refuses an unknown session and an unknown Simulator", async () => {
    const host = fakeHost();

    const noSession = await run(
      host,
      (hub) => Effect.exit(Stream.runHead(hub.attach(SESSION, OURS))),
      { presence: () => Effect.succeed("unknown") }
    );

    expect(JSON.stringify(noSession)).toContain("NotFound");

    const noSimulator = await run(host, (hub) =>
      Effect.exit(Stream.runHead(hub.attach(SESSION, "no-such-udid")))
    );

    expect(JSON.stringify(noSimulator)).toContain("SimulatorNotFound");
  });

  test("the session feed shows what an agent opened and whether it drives", async () => {
    const host = fakeHost();

    const items = await run(host, (hub) =>
      Effect.gen(function* () {
        const seen: Array<SimulatorSessionItem> = [];

        const fiber = yield* hub.sessionFeed(SESSION).pipe(
          Stream.runForEach((item) => Effect.sync(() => seen.push(item))),
          Effect.forkScoped
        );

        yield* Effect.promise(() => until(() => seen.length === 1));
        yield* hub.agentOpened(SESSION, OURS);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* hub.agentDriving(SESSION);
            yield* Effect.scoped(hub.agentDriving(SESSION));
          })
        );
        expect(yield* hub.shown(SESSION)).toBe(OURS);
        yield* Effect.promise(() => until(() => seen.length === 5));
        yield* Fiber.interrupt(fiber);

        return seen;
      })
    );

    const { Showing, AgentOpened, AgentDriving } = SimulatorSessionItem.cases;
    expect(items).toEqual([
      Showing.make({ id: null }),
      Showing.make({ id: OURS }),
      AgentOpened.make({ id: OURS }),
      AgentDriving.make({ active: true }),
      AgentDriving.make({ active: false }),
    ]);
  });
});
