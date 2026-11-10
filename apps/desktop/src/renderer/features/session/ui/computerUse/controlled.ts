/**
 * The apps each session controls on a Host (`computerUse.watch`'s `ControlledApps`), shared:
 * one subscription per Host however many sidebar rows ask, closed with the last of them.
 */
import type { ControlledApp, SessionId } from "@polaris/protocol";
import { Predicate } from "effect";
import { useSyncExternalStore } from "react";
import { polaris } from "../../../bridge.ts";

interface HostWatch {
  apps: ReadonlyArray<ControlledApp>;
  readonly listeners: Set<() => void>;
  readonly close: () => void;
}

const watches = new Map<string, HostWatch>();

const NONE: ReadonlyArray<ControlledApp> = [];

const open = (hostKey: string): HostWatch => {
  const listeners = new Set<() => void>();

  const watch: HostWatch = {
    apps: NONE,
    listeners,
    close: polaris().subscribe(
      "computerUse.watch",
      { hostKey },
      {
        items: (items) => {
          const last = items.findLast((item) => Predicate.isTagged(item, "ControlledApps"));

          if (last === undefined || !Predicate.isTagged(last, "ControlledApps")) return;
          watch.apps = last.apps;

          for (const listener of listeners) listener();
        },
      }
    ),
  };

  return watch;
};

const subscribers = new Map<string, (listener: () => void) => () => void>();

const subscribeTo = (hostKey: string) => (listener: () => void) => {
  const watch = watches.get(hostKey) ?? open(hostKey);

  watches.set(hostKey, watch);
  watch.listeners.add(listener);

  return () => {
    watch.listeners.delete(listener);

    if (watch.listeners.size > 0) return;
    watch.close();
    watches.delete(hostKey);
  };
};

/** One function per Host, so React keeps its subscription across renders. */
const subscribe = (hostKey: string) => {
  const known = subscribers.get(hostKey);

  if (known !== undefined) return known;
  const made = subscribeTo(hostKey);

  subscribers.set(hostKey, made);

  return made;
};

/** The app `sessionId` controls now, or null; null on a Host without computer use. */
export const useControlledApp = (hostKey: string, sessionId: SessionId): ControlledApp | null =>
  useSyncExternalStore(
    subscribe(hostKey),
    () => watches.get(hostKey)?.apps.find((c) => c.sessionId === sessionId) ?? null
  );
