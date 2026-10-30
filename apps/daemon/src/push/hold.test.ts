/**
 * ENG-495 through the real notifier and `HostPresence`: fakes only at the boundary (the
 * Host stream, read positions and the relay's wake).
 */
import { expect, test } from "bun:test";
import { ApprovalDecision, DomainEvent, type HostStreamItem, RequestId } from "@polaris/protocol";
import type { PushMessage } from "@polaris/protocol/relay";
import { Effect, Layer, PubSub, Stream } from "effect";
import { RelayRoute } from "../linkedDevices/route.ts";
import type { PushTarget } from "../linkedDevices/store.ts";
import { HostPresence } from "../presence/index.ts";
import { hold } from "./hold.ts";
import { PushHostEvents, PushNotifier } from "./notifier.ts";
import { emptyPlan, planItem, planSettled, type Push, SETTLE_MS } from "./plan.ts";
import {
  approvalRequested,
  event,
  notified,
  SESSION_ID,
  snapshot,
  synchronized,
  turnEnded,
} from "./push.testing.ts";

const unused = Effect.die("not used by the notifier");

// SAFETY: the notifier reads only `registration.automatic`; `wake` below never looks at it.
const target = { device: {}, registration: {} } as PushTarget;

const resolved = (requestId: string) =>
  event(
    DomainEvent.cases.ApprovalResolved.make({
      sessionId: SESSION_ID,
      requestId: RequestId.make(requestId),
      decision: ApprovalDecision.cases.Allow.make({ remember: false }),
      resolvedBy: "MacBook Pro",
    })
  );

/** Runs `body` with a notifier on a fake Host stream; `woken` lists what reached the relay. */
const withNotifier = (
  leaseMs: number,
  body: (input: {
    readonly feed: (item: HostStreamItem) => void;
    readonly presence: HostPresence["Service"];
    readonly woken: ReadonlyArray<PushMessage>;
  }) => Effect.Effect<void>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<HostStreamItem>();
        const woken: Array<PushMessage> = [];
        const presence = HostPresence.make({ leaseMs });

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
          pushTargets: () => [target],
          watchPush: () => () => {},
          registerLiveActivity: () => unused,
          unregisterLiveActivity: () => unused,
          liveTargets: () => [],
          watchLive: () => () => {},
          sendLive: () => false,
          host: { hostId: "host-1", hostName: "studio" },
          wake: (_, message) => Effect.sync(() => (woken.push(message), "sent" as const)),
        });

        yield* Layer.build(
          PushNotifier.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(PushHostEvents)({
                  subscribe: () =>
                    Stream.concat(
                      Stream.make(snapshot(), synchronized()),
                      Stream.fromPubSub(events)
                    ),
                }),
                Layer.succeed(RelayRoute)(route),
                Layer.succeed(HostPresence)(presence)
              )
            )
          )
        );
        // The notifier subscribes in the background.
        yield* Effect.sleep("50 millis");
        yield* body({
          feed: (item) => Effect.runSync(PubSub.publish(events, item)),
          presence,
          woken,
        });
      })
    )
  );

const requestIds = (woken: ReadonlyArray<PushMessage>) => woken.map((m) => m.requestId);

test("while the user is present a Needs You is held, and goes out when they are away", () =>
  withNotifier(60_000, ({ feed, presence, woken }) =>
    Effect.gen(function* () {
      presence.report(1, "present");
      feed(approvalRequested("r1"));
      yield* Effect.sleep("100 millis");
      expect(woken).toEqual([]);

      presence.report(1, "away");
      yield* Effect.sleep("50 millis");
      expect(requestIds(woken)).toEqual(["r1"]);
    })
  ));

test("a request answered at the Mac while held never pushes", () =>
  withNotifier(60_000, ({ feed, presence, woken }) =>
    Effect.gen(function* () {
      presence.report(1, "present");
      feed(approvalRequested("r1"));
      feed(approvalRequested("r2"));
      feed(resolved("r1"));
      yield* Effect.sleep("50 millis");
      presence.report(1, "away");
      yield* Effect.sleep("50 millis");
      expect(requestIds(woken)).toEqual(["r2"]);
    })
  ));

test("a lapsed lease sends what was held, with no away report", () =>
  withNotifier(150, ({ feed, presence, woken }) =>
    Effect.gen(function* () {
      presence.report(1, "present");
      feed(approvalRequested("r1"));
      yield* Effect.sleep("50 millis");
      expect(woken).toEqual([]);
      yield* Effect.sleep("250 millis");
      expect(requestIds(woken)).toEqual(["r1"]);
    })
  ));

test("a notification while present reaches the phone neither then nor once the user is away", () =>
  withNotifier(60_000, ({ feed, presence, woken }) =>
    Effect.gen(function* () {
      presence.report(1, "present");
      feed(notified("n1", false));
      yield* Effect.sleep("50 millis");
      presence.report(1, "away");
      feed(notified("n2", false));
      yield* Effect.sleep("50 millis");
      // Only n2, sent once away; n1 isn't held for later.
      expect(woken.map((m) => m.kind)).toEqual(["notify"]);
    })
  ));

test("with two Desktop Apps the Host stays quiet until both are away", () =>
  withNotifier(60_000, ({ feed, presence, woken }) =>
    Effect.gen(function* () {
      presence.report(1, "present");
      presence.report(2, "present");
      feed(approvalRequested("r1"));
      presence.report(1, "away");
      yield* Effect.sleep("50 millis");
      expect(woken).toEqual([]);
      presence.disconnect(2);
      yield* Effect.sleep("50 millis");
      expect(requestIds(woken)).toEqual(["r1"]);
    })
  ));

const host = { hostId: "host-1", hostName: "studio" };

/** A finished Turn, an agent's notification and a Needs You, as the plan pushes them. */
const planned = (): ReadonlyArray<Push> => {
  let state = emptyPlan;
  const pushes: Array<Push> = [];

  for (const item of [
    snapshot(),
    synchronized(),
    notified("n1", false),
    turnEnded("t1", "All green"),
    approvalRequested("r1"),
  ]) {
    const next = planItem(state, item, { ...host, now: 1_000 });
    state = next.state;
    pushes.push(...next.send);
  }

  return [...pushes, ...planSettled(state, { ...host, now: 1_000 + SETTLE_MS }).send];
};

// ENG-524: the Desktop App showed these as banners; on away they'd arrive as a burst.
test("only a Needs You is held: finished Turns and notifications at the Mac never reach the phone", () => {
  expect(planned().map(({ message }) => message.kind)).toEqual([
    "notify",
    "needs-you",
    "turn-ended",
  ]);
  expect(hold([], planned()).map(({ message }) => message.requestId)).toEqual(["r1"]);
});
