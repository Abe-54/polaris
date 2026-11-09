/**
 * Each Host's Simulator support and Simulators, from `simulator.watch`. The tab's visibility
 * needs only one Snapshot, so a Host is watched live only while a Simulator pane shows: the
 * Daemon polls `simctl` while a watch is open, and an idle Host should stay idle.
 */
import type { HostSimulatorSupport, Simulator, SimulatorWatchItem } from "@polaris/protocol";
import { Match } from "effect";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { polaris } from "../bridge.ts";
import { keepSubscribed } from "./resubscribe.ts";

export interface HostSimulators {
  readonly support: HostSimulatorSupport;
  readonly simulators: ReadonlyArray<Simulator>;
}

const store = createStore<Readonly<Record<string, HostSimulators>>>(() => ({}));

/** One `simulator.watch` item folded into what the Host had. */
export const applyWatchItem = (
  current: HostSimulators | undefined,
  item: SimulatorWatchItem
): HostSimulators | undefined =>
  Match.value(item).pipe(
    Match.tagsExhaustive({
      Snapshot: ({ support, simulators }): HostSimulators => ({ support, simulators }),
      SupportChanged: ({ support }) =>
        current === undefined ? undefined : { ...current, support },
      SimulatorChanged: ({ simulator }) =>
        current === undefined
          ? undefined
          : {
              ...current,
              simulators: current.simulators.some((s) => s.id === simulator.id)
                ? current.simulators.map((s) => (s.id === simulator.id ? simulator : s))
                : [...current.simulators, simulator],
            },
      SimulatorRemoved: ({ id }) =>
        current === undefined
          ? undefined
          : { ...current, simulators: current.simulators.filter((s) => s.id !== id) },
    })
  );

const fold = (hostKey: string, items: ReadonlyArray<SimulatorWatchItem>) =>
  store.setState((s) => {
    let next = s[hostKey];

    for (const item of items) next = applyWatchItem(next, item);

    return next === undefined || next === s[hostKey] ? s : { ...s, [hostKey]: next };
  });

/** Watches open per Host, so two panes on one Host share a subscription. */
const live = new Map<string, { count: number; stop: () => void }>();

/** Probes in flight, so the rail and the tab row don't both ask. */
const probing = new Set<string>();

/** One Snapshot, then unsubscribes: enough to decide the tab and the setup state. */
const probe = (hostKey: string) => {
  if (probing.has(hostKey) || live.has(hostKey)) return;
  probing.add(hostKey);

  let stop: (() => void) | null = null;
  let done = false;

  const finish = () => {
    done = true;
    probing.delete(hostKey);
    stop?.();
  };

  stop = polaris().subscribe(
    "simulator.watch",
    { hostKey },
    {
      items: (items) => {
        fold(hostKey, items);
        finish();
      },
      end: () => {
        if (!done) finish();
      },
    }
  );

  if (done) stop();
};

const liveWatch = (hostKey: string) =>
  keepSubscribed(({ alive, ended }) =>
    polaris().subscribe(
      "simulator.watch",
      { hostKey },
      {
        items: (items) => {
          alive();
          fold(hostKey, items);
        },
        end: ended,
      }
    )
  );

const watch = (hostKey: string) => {
  const open = live.get(hostKey);

  if (open !== undefined) {
    open.count += 1;

    return;
  }

  live.set(hostKey, { count: 1, stop: liveWatch(hostKey) });
};

const unwatch = (hostKey: string) => {
  const open = live.get(hostKey);

  if (open === undefined) return;
  open.count -= 1;

  if (open.count > 0) return;
  open.stop();
  live.delete(hostKey);
};

/**
 * "Check again": subscribing has the Daemon detect support afresh. A live watch reopens; otherwise
 * one more probe.
 */
export const checkAgain = (hostKey: string) => {
  const open = live.get(hostKey);

  if (open === undefined) return probe(hostKey);
  open.stop();
  open.stop = liveWatch(hostKey);
};

export const hostSimulators = (hostKey: string): HostSimulators | null =>
  store.getState()[hostKey] ?? null;

/** The Host's Simulators as last known; probes once when `capable` and nothing is known yet. */
export const useHostSimulators = (hostKey: string, capable: boolean): HostSimulators | null => {
  const known = useStore(store, (s) => s[hostKey] ?? null);

  useEffect(() => {
    if (capable && hostSimulators(hostKey) === null) probe(hostKey);
  }, [hostKey, capable]);

  return capable ? known : null;
};

/** Keeps the Host's list live while the caller is mounted (a shown Simulator pane). */
export const useLiveSimulators = (hostKey: string, capable: boolean) =>
  useEffect(() => {
    if (!capable) return;
    watch(hostKey);

    return () => unwatch(hostKey);
  }, [hostKey, capable]);
