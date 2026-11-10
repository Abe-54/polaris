/**
 * The Host feed (`computerUse.watch`): a `Status`, `AllowedApps` and `ControlledApps` first,
 * then each again, whole, when it changes. Watching never checks the Host by itself.
 */
import { ComputerUseItem, type ComputerUseStatus } from "@polaris/protocol";
import { Effect, Stream } from "effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HostState } from "./host.ts";

export type HostFeed = Stream.Stream<ComputerUseItem>;

const itemsOf = (state: HostState, status: ComputerUseStatus) => ({
  status: ComputerUseItem.cases.Status.make({ status }),
  allowed: ComputerUseItem.cases.AllowedApps.make({
    apps: state.stored.allowed.toSorted((a, b) => a.app.name.localeCompare(b.app.name)),
  }),
  controlled: ComputerUseItem.cases.ControlledApps.make({ apps: state.controlled }),
});

type Seen = { readonly state: HostState | null; readonly items: ReadonlyArray<ComputerUseItem> };

/** What changed between two states, as feed items; everything for the first. */
const changed = (previous: HostState | null, state: HostState, status: ComputerUseStatus) => {
  const items = itemsOf(state, status);

  if (previous === null) return [items.status, items.allowed, items.controlled];

  return [
    ...(previous.status === state.status ? [] : [items.status]),
    ...(previous.stored.allowed === state.stored.allowed ? [] : [items.allowed]),
    ...(previous.controlled === state.controlled ? [] : [items.controlled]),
  ];
};

/** `current` answers the first status when nothing has checked the Host yet. */
export const feedOf = (
  ref: SubscriptionRef.SubscriptionRef<HostState>,
  current: Effect.Effect<ComputerUseStatus>
): HostFeed =>
  Stream.unwrap(
    Effect.map(current, (first) =>
      SubscriptionRef.changes(ref).pipe(
        Stream.mapAccum(
          (): Seen => ({ state: null, items: [] }),
          (seen, state) => {
            const items = changed(seen.state, state, state.status ?? first);

            return [{ state, items }, items];
          }
        )
      )
    )
  );
