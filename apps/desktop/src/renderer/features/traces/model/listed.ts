/**
 * The sidebar's latest list per Agent Session, so the open trace can tell when the summary the
 * sidebar shows for it grows (its exporter sent another batch) and read it again.
 */
import type { TraceSummary } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { scopedKey, type TracesSessionKey } from "./session.ts";

const store = createStore<Readonly<Record<string, ReadonlyArray<TraceSummary>>>>(() => ({}));

const keyOf = scopedKey;

/** `traces` as the sidebar lists them; null when it lists none (unmounted, loading, failed). */
export const publishListed = (at: TracesSessionKey, traces: ReadonlyArray<TraceSummary> | null) =>
  store.setState((s) => {
    const key = keyOf(at);

    if (traces === null) {
      const { [key]: _gone, ...rest } = s;

      return rest;
    }

    return { ...s, [key]: traces };
  }, true);

/** What changes as a trace grows: its span count and duration, or null when it isn't listed. */
export const summaryVersion = (summary: Pick<TraceSummary, "spans" | "durationMs">) =>
  `${summary.spans}:${summary.durationMs}`;

/** The listed summary's version for `traceId` (which may be a prefix), or null. */
export const useListedVersion = (at: TracesSessionKey, traceId: string | null): string | null =>
  useStore(store, (s) => {
    const found =
      traceId === null ? undefined : s[keyOf(at)]?.find((t) => t.id.startsWith(traceId));

    return found === undefined ? null : summaryVersion(found);
  });
