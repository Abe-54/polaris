import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AttemptId, DomainEvent, ResourceLease } from "@polaris/protocol";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { CID, HOST } from "../../engine/constellation.testing.ts";
import { WORKERS_RESOURCE } from "../../resources/model.ts";
import { EventStore } from "../../store/EventStore.ts";
import { ConstellationDelivery } from "./index.ts";
import { WORKER, setup, wait, world } from "./testing.ts";
import { newTempDir, removeTempDir } from "../../platform/tempDir.testing.ts";

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

// After the Attempt's (wall-clock) start, so the slot's grant starts the grace period.
const HELD = new Date(Date.now() + 3_600_000).toISOString();

const grantSlot = Effect.fnUntraced(function* () {
  const store = yield* EventStore;
  yield* store.commit({
    commandId: null,
    decide: () =>
      Effect.succeed([
        DomainEvent.cases.ResourceLeased.make({
          lease: new ResourceLease({
            id: "slot",
            hostId: HOST,
            resource: WORKERS_RESOURCE,
            sessionId: WORKER,
            command: [],
            processId: 0,
            acquiredAt: HELD,
          }),
        }),
      ]),
  });
});

const pendingTimer = Effect.fnUntraced(function* () {
  const delivery = yield* ConstellationDelivery;
  yield* wait(() => Effect.map(delivery.pendingTimers, (n) => n === 1));
});

test("a worker holding a slot with no first Turn is flagged to the Lead once, across restarts", async () => {
  const dir = newTempDir("slot-stall-", { short: true });
  dirs.push(dir);
  const file = join(dir, "state.sqlite");

  // The slot is granted after dispatch; the grant alone arms the wake, and a restart loses it.
  await world(file, { canSteer: false }).run(
    Effect.gen(function* () {
      yield* setup();
      yield* (yield* ConstellationDelivery).start();
      yield* TestClock.setTime(Date.parse(HELD));
      yield* grantSlot();
      yield* pendingTimer();
    })
  );

  const restarted = world(file, { canSteer: false });
  await restarted.run(
    Effect.gen(function* () {
      yield* (yield* ConstellationDelivery).start();
      yield* pendingTimer();
      yield* TestClock.setTime(Date.parse(HELD) + 59_999);
      expect(restarted.turns).toHaveLength(0);
      yield* TestClock.adjust(1);
      yield* wait(() => Effect.succeed(restarted.turns.length === 1));
      expect(restarted.prompts[0]).toContain(
        "Stalled: A holds a worker slot with no Turn yet. The user can press Start on it"
      );
      const record = (yield* (yield* EventStore).model).constellations.get(CID)!;
      expect([...record.slotStalls]).toEqual([AttemptId.make("a1")]);
    })
  );

  // The audit is folded from the log: the next start neither repeats it nor re-arms a wake.
  const again = world(file, { canSteer: false });
  await again.run(
    Effect.gen(function* () {
      const delivery = yield* ConstellationDelivery;
      yield* delivery.start();
      yield* TestClock.setTime(Date.parse(HELD) + 3_600_000);
      yield* delivery.flush();
      expect(yield* delivery.pendingTimers).toBe(0);
      expect(again.turns).toHaveLength(0);
    })
  );
});
