/**
 * Refreshing a checkout's Data Sources (F14): a bump re-subscribes `data.sources.watch`, and the
 * Daemon re-lists on subscribe. At most once a second per session.
 */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { type DataSessionKey, dataSessionKey } from "./store.ts";

export const REFRESH_MS = 1000;

interface Generations {
  /** Subscriptions asked for, by session. */
  readonly asked: Readonly<Record<string, number>>;
  /** The subscription whose first snapshot has arrived, by session. */
  readonly listed: Readonly<Record<string, number>>;
}

const generations = createStore<Generations>(() => ({ asked: {}, listed: {} }));

const last = new Map<string, number>();

/** Re-subscribes the session's sources watch, unless it did so less than a second ago. */
export const refreshSources = (at: DataSessionKey, now = Date.now()) => {
  const key = dataSessionKey(at);
  const previous = last.get(key);

  if (previous !== undefined && now - previous < REFRESH_MS) return;
  last.set(key, now);
  generations.setState((s) => ({ ...s, asked: { ...s.asked, [key]: (s.asked[key] ?? 0) + 1 } }));
};

/** Records that a subscription's first snapshot arrived: the sources are freshly listed. */
export const markListed = (at: DataSessionKey, generation: number) => {
  const key = dataSessionKey(at);

  generations.setState((s) => ({ ...s, listed: { ...s.listed, [key]: generation } }));
};

export const generationOf = (at: DataSessionKey) =>
  generations.getState().asked[dataSessionKey(at)] ?? 0;

/** Which subscription of the session's sources watch is current. */
export const useSourcesGeneration = (at: DataSessionKey) =>
  useStore(generations, (s) => s.asked[dataSessionKey(at)] ?? 0);

/** Whether the current subscription has delivered: what's shown is what the checkout holds now. */
export const useSourcesListed = (at: DataSessionKey) =>
  useStore(generations, (s) => {
    const key = dataSessionKey(at);

    return (s.listed[key] ?? -1) >= (s.asked[key] ?? 0);
  });
