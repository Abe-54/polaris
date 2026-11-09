/** LiveNotifier's timing through the real fold and sealing; fakes for the Host stream and the relay. */
import { expect, test } from "bun:test";
import { DomainEvent, type HostStreamItem, TurnId, TurnItem } from "@polaris/protocol";
import { Effect, Layer, PubSub, Stream } from "effect";
import { type LiveSlice, RelayRoute } from "../linkedDevices/route.ts";
import type { LiveTarget } from "../linkedDevices/store.ts";
import { LIVE_DEBOUNCE_MS, LiveHostEvents, LiveNotifier } from "./liveNotifier.ts";
import {
  approvalRequested,
  event,
  openSlice,
  SESSION_ID,
  snapshot,
  synchronized,
  waitUntil,
} from "./push.testing.ts";
import { pushSuite } from "./seal.ts";
import { toBase64Url } from "@polaris/protocol/relay";

const unused = Effect.die("not used by the notifier");

// Sealing is asynchronous, so a slice reaches `sent` some time after its flush.
const SLOW_TEST_MS = 30_000;

const keys = await pushSuite.kem.generateKeyPair();

const pushKey = toBase64Url(new Uint8Array(await pushSuite.kem.serializePublicKey(keys.publicKey)));

// SAFETY: the notifier reads only `registration.pushKey`; `sendLive` below records the rest.
const target = { device: {}, registration: { pushKey } } as LiveTarget;

const step = (line: string) =>
  event(
    DomainEvent.cases.TurnItemCompleted.make({
      sessionId: SESSION_ID,
      turnId: TurnId.make("t1"),
      item: TurnItem.cases.ToolCall.make({
        id: line,
        startedAt: null,
        name: line,
        input: {},
        output: null,
        status: "completed",
      }),
      subagentId: null,
    })
  );

const withNotifier = (
  targets: ReadonlyArray<LiveTarget>,
  body: (input: {
    readonly feed: (item: HostStreamItem) => void;
    readonly sent: ReadonlyArray<LiveSlice>;
    readonly reconnect: () => void;
    readonly subscriptions: () => number;
  }) => Effect.Effect<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<HostStreamItem>();
        const sent: Array<LiveSlice> = [];
        const listeners = new Set<() => void>();
        let subscriptions = 0;

        const route = RelayRoute.of({
          status: unused,
          enable: () => unused,
          disable: unused,
          startLink: unused,
          awaitLink: () => unused,
          cancelLink: () => unused,
          add: () => unused,
          list: unused,
          watch: Stream.empty,
          unlink: () => unused,
          unlinkSelf: () => unused,
          registerPush: () => unused,
          unregisterPush: () => unused,
          pushTargets: () => [],
          watchPush: () => () => {},
          registerLiveActivity: () => unused,
          unregisterLiveActivity: () => unused,
          liveTargets: () => targets,
          watchLive: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
          sendLive: (_, slice) => (sent.push(slice), true),
          host: { hostId: "host-1", hostName: "studio" },
          wake: () => unused,
        });

        yield* Layer.build(
          LiveNotifier.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(LiveHostEvents)({
                  subscribe: () => {
                    subscriptions++;

                    return Stream.concat(
                      Stream.make(snapshot(), synchronized()),
                      Stream.fromPubSub(events)
                    );
                  },
                }),
                Layer.succeed(RelayRoute)(route)
              )
            )
          )
        );
        yield* waitUntil(
          () => (targets.length === 0 || sent.length > 0 ? true : undefined),
          "the first slice"
        );
        yield* body({
          feed: (item) => Effect.runSync(PubSub.publish(events, item)),
          sent,
          reconnect: () => listeners.forEach((listener) => listener()),
          subscriptions: () => subscriptions,
        });
      })
    )
  );

const flags = (sent: ReadonlyArray<LiveSlice>) =>
  sent.map(({ active, alert }) => ({ active, alert }));

const reached = (sent: ReadonlyArray<LiveSlice>, count: number) =>
  waitUntil(() => (sent.length >= count ? true : undefined), `slice ${count}`);

test(
  "a burst of steps goes as one slice after the debounce; a new Needs You goes at once",
  () =>
    withNotifier([target], ({ feed, sent }) =>
      Effect.gen(function* () {
        // The first slice follows Synchronized.
        expect(flags(sent)).toEqual([{ active: true, alert: false }]);

        const burst = Date.now();
        feed(step("Read a.ts"));
        feed(step("Read b.ts"));
        feed(step("Read c.ts"));
        yield* reached(sent, 2);
        // Timers may fire a tick early; load only makes this later.
        expect(Date.now() - burst).toBeGreaterThanOrEqual(LIVE_DEBOUNCE_MS - 20);

        // A step's debounce is already running, so a delayed alert would come after its slice.
        feed(step("Read d.ts"));
        feed(approvalRequested("r1"));
        yield* reached(sent, 3);
        yield* Effect.sleep(`${LIVE_DEBOUNCE_MS + 100} millis`);
        expect(flags(sent)).toEqual([
          { active: true, alert: false },
          { active: true, alert: false },
          { active: true, alert: true },
        ]);
      })
    ),
  SLOW_TEST_MS
);

test(
  "an item that changes nothing shown sends nothing; a relay reconnect sends the slice again",
  () =>
    withNotifier([target], ({ feed, sent, reconnect }) =>
      Effect.gen(function* () {
        feed(
          event(DomainEvent.cases.SessionPinned.make({ sessionId: SESSION_ID, pinnedAt: null }))
        );
        yield* Effect.sleep(`${LIVE_DEBOUNCE_MS + 100} millis`);
        expect(sent).toHaveLength(1);

        reconnect();
        yield* reached(sent, 2);
        expect(sent[1]?.sealed).not.toBe(sent[0]?.sealed);
      })
    ),
  SLOW_TEST_MS
);

test(
  "a clean shutdown sends a last idle slice, so the activity stops saying working",
  async () => {
    let kept: ReadonlyArray<LiveSlice> = [];

    await withNotifier([target], ({ sent }) =>
      Effect.sync(() => {
        kept = sent;
      })
    );

    expect(flags(kept)).toEqual([
      { active: true, alert: false },
      { active: false, alert: false },
    ]);
    const last = kept[1]?.sealed ?? "";
    expect(await openSlice(keys.privateKey, last)).toMatchObject({
      working: 0,
      needs: 0,
      step: null,
    });
  },
  SLOW_TEST_MS
);

test("with no activity registered, the Host stream isn't followed and nothing is sent", () =>
  withNotifier([], ({ feed, sent, subscriptions }) =>
    Effect.gen(function* () {
      feed(step("Read a.ts"));
      yield* Effect.sleep(`${LIVE_DEBOUNCE_MS + 100} millis`);
      expect([subscriptions(), sent.length]).toEqual([0, 0]);
    })
  ));
