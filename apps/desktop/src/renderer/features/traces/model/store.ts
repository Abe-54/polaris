/** The trace and span open in each Agent Session's Traces, kept while the user moves around. */
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopedKey, type TracesSessionKey } from "./session.ts";

export interface TracesSelection {
  readonly traceId: string | null;
  readonly spanId: string | null;
}

const NONE: TracesSelection = { traceId: null, spanId: null };

const store = createStore<Readonly<Record<string, TracesSelection>>>(() => ({}));

const keyOf = scopedKey;

const set = (at: TracesSessionKey, next: TracesSelection) =>
  store.setState((s) => ({ ...s, [keyOf(at)]: next }));

/** Opens a trace with no span selected; null closes it. */
export const selectTrace = (at: TracesSessionKey, traceId: string | null) =>
  set(at, { traceId, spanId: null });

/** Selects a span in the open trace; null closes the span panel. */
export const selectSpan = (at: TracesSessionKey, spanId: string | null) =>
  set(at, { traceId: store.getState()[keyOf(at)]?.traceId ?? null, spanId });

export const tracesSelection = (at: TracesSessionKey): TracesSelection =>
  store.getState()[keyOf(at)] ?? NONE;

export const useTracesSelection = (at: TracesSessionKey): TracesSelection =>
  useStore(store, (s) => s[keyOf(at)] ?? NONE);
