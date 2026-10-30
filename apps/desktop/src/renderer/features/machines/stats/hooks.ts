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

/**
 * A Host's stats while `watch` (connected, and its list row or page on screen): the samples
 * stay after the feed ends, so a Reconnecting host's chart stops where its samples stopped.
 */
export const useHostStats = (hostKey: string, watch: boolean): HostStats | null => {
  const [stats, setStats] = useState<HostStats | null>(null);
  const visible = useDocumentVisible();
  const live = watch && visible;

  useEffect(() => {
    if (!live) return undefined;

    return polaris().subscribe(
      "host.stats",
      { hostKey },
      { items: (items) => setStats((current) => items.reduce(foldStats, current)) }
    );
  }, [hostKey, live]);

  return stats;
};

/** `value` while `still` is false; under Reduce Motion, the value it had when it stilled. */
export const useStill = <T>(value: T, still: boolean): T => {
  const held = useRef(value);

  if (!still) held.current = value;

  return still ? held.current : value;
};
