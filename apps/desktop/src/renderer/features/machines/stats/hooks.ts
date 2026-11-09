/**
 * The live side of host stats: a Host's `host.stats` feed while it is watched, and the two
 * conditions that still the charts (a hidden window, Reduce Motion). The Daemon samples only
 * while a Client is subscribed, so nothing here runs while Settings → Hosts isn't on screen.
 */
import { reducedMotion } from "@polaris/ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { polaris } from "../../bridge.ts";
import { foldStats, type HostStats } from "./model.ts";

const subscribeVisibility = (notify: () => void) => {
  document.addEventListener("visibilitychange", notify);

  return () => document.removeEventListener("visibilitychange", notify);
};

/** False while the window is hidden or minimised. */
export const useDocumentVisible = (): boolean =>
  useSyncExternalStore(subscribeVisibility, () => document.visibilityState !== "hidden");

const subscribeMotion = (notify: () => void) => {
  const query = matchMedia("(prefers-reduced-motion: reduce)");
  const observer = new MutationObserver(notify);

  query.addEventListener("change", notify);
  observer.observe(document.documentElement, { attributeFilter: ["data-reduce-motion"] });

  return () => {
    query.removeEventListener("change", notify);
    observer.disconnect();
  };
};

/** The app's Motion setting, else the system's Reduce Motion, live. */
export const useReducedMotion = (): boolean => useSyncExternalStore(subscribeMotion, reducedMotion);

/** The wait before reopening a feed that ended after `failures` ends in a row: 1 s doubling to 30 s. */
export const statsRetryDelay = (failures: number) => Math.min(1000 * 2 ** failures, 30_000);

export interface HostStatsOptions {
  readonly retryMs?: (failures: number) => number;
}

/**
 * A Host's stats while `watch` (connected, and its list row or page on screen): the samples
 * stay after the feed ends, so a Reconnecting host's chart stops where its samples stopped.
 * A feed that ends while still watched opens again after a backoff; samples reset the backoff.
 */
export const useHostStats = (
  hostKey: string,
  watch: boolean,
  { retryMs = statsRetryDelay }: HostStatsOptions = {}
): HostStats | null => {
  const [stats, setStats] = useState<HostStats | null>(null);
  const visible = useDocumentVisible();
  const live = watch && visible;
  const retry = useRef(retryMs);

  retry.current = retryMs;

  useEffect(() => {
    if (!live) return undefined;
    let failures = 0;
    let stopped = false;
    let close: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      if (stopped) return;
      close = polaris().subscribe(
        "host.stats",
        { hostKey },
        {
          items: (items) => {
            failures = 0;
            setStats((current) => items.reduce(foldStats, current));
          },
          end: () => {
            if (stopped) return;
            timer = setTimeout(open, retry.current(failures));
            failures += 1;
          },
        }
      );
    };

    open();

    return () => {
      stopped = true;
      clearTimeout(timer);
      close();
    };
  }, [hostKey, live]);

  return stats;
};

/** `value` while `still` is false; under Reduce Motion, the value it had when it stilled. */
export const useStill = <T>(value: T, still: boolean): T => {
  const held = useRef(value);

  if (!still) held.current = value;

  return still ? held.current : value;
};
