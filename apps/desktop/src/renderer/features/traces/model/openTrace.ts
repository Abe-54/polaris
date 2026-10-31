/**
 * The open trace as the waterfall loaded it, per Agent Session, so the trace bar reads the same
 * answer instead of fetching every span again.
 */
import type { TraceDetail } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { TracesSessionKey } from "./session.ts";

const store = createStore<Readonly<Record<string, TraceDetail>>>(() => ({}));

const keyOf = (at: TracesSessionKey) => `${at.hostKey}\u0000${at.sessionId}`;

/** The waterfall's answer for `at`; null when it has none (nothing open, loading, failed). */
export const publishOpenTrace = (at: TracesSessionKey, detail: TraceDetail | null) =>
  store.setState((s) => {
    const key = keyOf(at);

    if (detail === null) {
      const { [key]: _gone, ...rest } = s;

      return rest;
    }

    return { ...s, [key]: detail };
  }, true);

/** The loaded trace if it is `traceId`, else null. */
export const useOpenTrace = (at: TracesSessionKey, traceId: string | null): TraceDetail | null =>
  useStore(store, (s) => {
    const detail = s[keyOf(at)];

    // A trace may be opened by an id prefix (traces.get takes one).
    return traceId !== null && detail?.summary.id.startsWith(traceId) === true ? detail : null;
  });
