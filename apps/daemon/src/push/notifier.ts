/**
 * Pushes Needs You, notifications and finished Turns to Linked Devices registered for push
 * (apps/relay README: Push). It follows the Engine's Host stream only while some device is
 * registered, so a Host without one pays nothing; a timer runs only while a Turn settles.
 * While the user is at a Desktop App (`HostPresence`) Needs You is held and the rest dropped (`hold.ts`).
 * After a restart, the sessions waiting on Continue are held again from the first Snapshot (ENG-500).
 */
import type { Capability, HostStreamItem, TurnId } from "@polaris/protocol";
import { Context, Effect, Fiber, Layer, Predicate, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { EventStore } from "../store/EventStore.ts";
import type { ReadModel } from "../store/model.ts";
import { RelayRoute } from "../linkedDevices/route.ts";
import { HostPresence } from "../presence/index.ts";
import { type Held, hold, settleItem } from "./hold.ts";
import {
  emptyPlan,
  markDigestTurn,
  nextSettle,
  type PlanState,
  planItem,
  planSettled,
  type Push,
  restoredNeeds,
} from "./plan.ts";

/** What the plan reads beyond the base Host stream. */
const PUSH_CAPABILITIES: ReadonlyArray<Capability> = ["session.notify", "constellation"];

/** Whether Polaris started Turn `turnId` to deliver a digest; a steered digest starts none. */
export const isDigestTurn = (model: ReadModel, turnId: TurnId): boolean =>
  [...model.constellations.values()].some((record) =>
    record.digests.some((d) => d.turnId === turnId && !d.steered)
  );

/** The Host stream the notifier follows (the Engine's, from now), and the digest Turns it can't carry. */
export class PushHostEvents extends Context.Service<
  PushHostEvents,
  {
    readonly subscribe: () => Stream.Stream<HostStreamItem>;
    /** `LeadNotified` stays off the Host stream, so this reads the store model (ENG-587). */
    readonly isDigestTurn: (turnId: TurnId) => Effect.Effect<boolean>;
  }
>()("polaris/daemon/push/PushHostEvents") {
  static readonly engine = Layer.effect(
    PushHostEvents,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const store = yield* EventStore;

      // Without these the Host stream leaves out `SessionNotified` and the Constellation events.
      return PushHostEvents.of({
        subscribe: () => engine.subscribeHost(null, { capabilities: PUSH_CAPABILITIES }),
        isDigestTurn: (turnId) => Effect.map(store.model, (model) => isDigestTurn(model, turnId)),
      });
    })
  );
}

/** The Turn a Host stream item ends, if any. */
const endedTurn = (item: HostStreamItem): TurnId | null =>
  Predicate.isTagged(item, "Event") && Predicate.isTagged(item.envelope.event, "TurnEnded")
    ? item.envelope.event.turn.id
    : null;

export const PushNotifier = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* PushHostEvents;
    const route = yield* RelayRoute;
    const presence = yield* HostPresence;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    let plan: PlanState = emptyPlan;
    let following: Fiber.Fiber<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let held: Held = [];
    /** Whether this Daemon's first Snapshot was re-planned yet (`restoredNeeds`). */
    let restored = false;

    const contextNow = () => ({ ...route.host, now: Date.now() });

    const wake = (pushes: ReadonlyArray<Push>) => {
      for (const { message, automatic } of pushes)
        for (const target of route.pushTargets())
          // The device's own setting for automatic notifications (ENG-462).
          if (!automatic || target.registration.automatic !== false)
            runFork(
              route
                .wake(target, message)
                .pipe(
                  Effect.flatMap((outcome) => Effect.logInfo(`push: ${message.kind} ${outcome}`))
                )
            );
    };

    // While the user is at a Desktop App the push waits for them to leave (ENG-495).
    const send = (pushes: ReadonlyArray<Push>) => {
      if (presence.present()) held = hold(held, pushes);
      else wake(pushes);
    };

    const release = (present: boolean) => {
      if (present) return;
      const due = held;
      held = [];
      wake(due);
    };

    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const next = nextSettle(plan);

      if (next === null) return;
      timer = setTimeout(settle, Math.max(0, next - Date.now()));
    };

    const settle = () => {
      timer = null;
      const planned = planSettled(plan, contextNow());
      plan = planned.state;
      send(planned.send);
      schedule();
    };

    const onItem = (item: HostStreamItem) =>
      Effect.gen(function* () {
        const ended = endedTurn(item);

        // The digest is committed with its TurnStarted, so the model has it by the Turn's end.
        if (ended !== null && (yield* events.isDigestTurn(ended)))
          plan = markDigestTurn(plan, ended);
        held = settleItem(held, item);

        // Held, whatever the presence now: the user hears of them when they next leave.
        if (!restored && Predicate.isTagged(item, "Snapshot")) {
          restored = true;
          held = hold(held, restoredNeeds(item, contextNow()));
        }

        const planned = planItem(plan, item, contextNow());
        plan = planned.state;
        send(planned.send);
        schedule();
      });

    const stop = () => {
      if (following !== null) runFork(Fiber.interrupt(following));
      following = null;
      plan = emptyPlan;
      held = [];
      schedule();
    };

    const reconcile = () => {
      const wanted = route.pushTargets().length > 0;

      if (wanted && following === null)
        following = runFork(Stream.runForEach(events.subscribe(), onItem));
      else if (!wanted && following !== null) stop();
    };

    const unwatch = route.watchPush(reconcile);
    const unwatchPresence = presence.watch(release);
    reconcile();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unwatch();
        unwatchPresence();
        stop();
      })
    );
  })
);

/** The notifier on the Engine's Host stream, as the Daemon runs it. */
export const PushNotifierLive = PushNotifier.pipe(Layer.provide(PushHostEvents.engine));
