/**
 * Sends this Host's slice of each registered Live Activity to the relay (docs/adr/0088). It
 * follows the Host stream only while some device has an activity registered; a change is sent
 * after `LIVE_DEBOUNCE_MS`, a new Needs You at once with an alert, and every slice again
 * whenever the registrations change or the relay socket connects. Nothing runs while idle.
 * A clean shutdown sends a last idle slice, so the activity stops saying "working" (ENG-585).
 */
import type { Capability, HostStreamItem } from "@polaris/protocol";
import { encodeHostSlice } from "@polaris/protocol/relay";
import { Context, Effect, Fiber, Layer, Stream } from "effect";
import { Engine } from "../engine/Engine.ts";
import { RelayRoute } from "../linkedDevices/route.ts";
import { sealSlice } from "./live.ts";
import {
  emptySlice,
  opensNeed,
  renderSlice,
  type SliceContent,
  type SliceState,
  sliceItem,
} from "./slice.ts";

/** How long changes gather before a slice goes out; the relay coalesces further, to one per 5 s. */
export const LIVE_DEBOUNCE_MS = 1_000;

/** How long shutdown waits for the last idle slice to be sealed and sent. */
const IDLE_SLICE_TIMEOUT = "2 seconds";

const LIVE_CAPABILITIES: ReadonlyArray<Capability> = ["session.user-turns"];

/** The Host stream the Live Activity follows: the Engine's, from now. */
export class LiveHostEvents extends Context.Service<
  LiveHostEvents,
  { readonly subscribe: () => Stream.Stream<HostStreamItem> }
>()("polaris/daemon/push/LiveHostEvents") {
  static readonly engine = Layer.effect(
    LiveHostEvents,
    Effect.gen(function* () {
      const engine = yield* Engine;

      return LiveHostEvents.of({
        subscribe: () => engine.subscribeHost(null, { capabilities: LIVE_CAPABILITIES }),
      });
    })
  );
}

export const LiveNotifier = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* LiveHostEvents;
    const route = yield* RelayRoute;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    let state: SliceState = emptySlice;
    let following: Fiber.Fiber<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seq = 0;
    /** What the last slice carried, so an unchanged one isn't sent again. */
    let sent: string | null = null;
    let sentNeeds: ReadonlySet<string> = new Set();

    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const sendSlice = (content: SliceContent, alert: boolean) => {
      const slice = { ...content, seq: ++seq };
      const active = content.working > 0 || content.needs > 0;

      return Effect.forEach(
        route.liveTargets(),
        (target) =>
          Effect.promise(() => sealSlice(target.registration.pushKey, slice)).pipe(
            Effect.map((sealed) => route.sendLive(target, { sealed, active, alert }))
          ),
        { concurrency: "unbounded", discard: true }
      );
    };

    const flush = (alert: boolean) => {
      cancel();
      const content = renderSlice(state, route.host);
      sent = encodeHostSlice({ ...content, seq: 0 });
      sentNeeds = new Set(state.needs.keys());
      runFork(sendSlice(content, alert));
    };

    // Nothing working, nothing waiting: what the activity shows once this Daemon has stopped.
    const sendIdle = () =>
      sendSlice(renderSlice(emptySlice, route.host), false).pipe(
        Effect.timeout(IDLE_SLICE_TIMEOUT),
        Effect.ignore
      );

    const changed = () => {
      if (!state.synchronized) return;

      if (opensNeed(sentNeeds, state)) return flush(true);

      if (encodeHostSlice({ ...renderSlice(state, route.host), seq: 0 }) === sent) return;
      timer ??= setTimeout(() => flush(false), LIVE_DEBOUNCE_MS);
    };

    const onItem = (item: HostStreamItem) =>
      Effect.sync(() => {
        const wasSynchronized = state.synchronized;
        state = sliceItem(state, item);

        // The first slice after subscribing carries what is already open, without an alert.
        if (!wasSynchronized && state.synchronized) flush(false);
        else changed();
      });

    const stop = () => {
      if (following !== null) runFork(Fiber.interrupt(following));
      following = null;
      state = emptySlice;
      sent = null;
      sentNeeds = new Set();
      cancel();
    };

    // Registrations changed or the relay connected: the relay may lack this Host's slice.
    const reconcile = () => {
      const wanted = route.liveTargets().length > 0;

      if (wanted && following === null)
        following = runFork(Stream.runForEach(events.subscribe(), onItem));
      else if (!wanted && following !== null) stop();
      else if (wanted && state.synchronized) flush(false);
    };

    const unwatch = route.watchLive(reconcile);
    reconcile();
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const sentSome = state.synchronized;
        unwatch();
        stop();

        return sentSome ? sendIdle() : Effect.void;
      })
    );
  })
);

/** The Live Activity notifier on the Engine's Host stream, as the Daemon runs it. */
export const LiveNotifierLive = LiveNotifier.pipe(Layer.provide(LiveHostEvents.engine));
