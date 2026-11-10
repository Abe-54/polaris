/**
 * `pv.state` writes from a frame, capped: a state over `STATE_MAX_BYTES` is dropped, and writes
 * land at most once per `STATE_INTERVAL_MS`, the latest winning, so a dragged slider can't flood
 * the disk.
 */
import type { SavedState, VisualizationStateStore } from "./stateStore.ts";

export const STATE_MAX_BYTES = 64 * 1024;

export const STATE_INTERVAL_MS = 500;

export interface StateWriter {
  /** False when the state was refused (too large, or not JSON). */
  readonly offer: (state: SavedState) => boolean;
  /** Writes what is pending now (on unmount). */
  readonly flush: () => void;
}

/** UTF-8 bytes of a JSON text, without TextEncoder (absent on older Hermes). */
const utf8Bytes = (text: string) => {
  let bytes = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    bytes += 1;

    if (code >= 0x80) bytes += 1;

    if (code >= 0x800) bytes += 1;

    if (code >= 0x10000) bytes += 1;
  }

  return bytes;
};

const encode = (state: SavedState): string | null => {
  try {
    const text = JSON.stringify(state);

    return text === undefined || utf8Bytes(text) > STATE_MAX_BYTES ? null : text;
  } catch {
    return null;
  }
};

export const stateWriter = (
  id: string,
  store: VisualizationStateStore,
  interval: number = STATE_INTERVAL_MS,
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const timer = setTimeout(run, ms);

    return () => clearTimeout(timer);
  }
): StateWriter => {
  let pending: { readonly state: SavedState } | null = null;
  let cancel: (() => void) | null = null;

  const flush = () => {
    cancel?.();
    cancel = null;

    if (pending === null) return;
    store.write(id, pending.state);
    pending = null;
  };

  return {
    offer: (state) => {
      if (encode(state) === null) return false;
      pending = { state };

      cancel ??= schedule(flush, interval);

      return true;
    },
    flush,
  };
};

const live = new Map<string, { readonly writer: StateWriter; holders: number }>();

export interface HeldWriter {
  readonly writer: StateWriter;
  /** The frame is gone: its state is written and, with no other holder, the writer is evicted. */
  readonly release: () => void;
}

/** One writer per Visualization, shared by its inline frame and its sheet while either is mounted. */
export const holdWriter = (
  id: string,
  store: VisualizationStateStore,
  schedule?: (run: () => void, ms: number) => () => void
): HeldWriter => {
  const held = live.get(id) ?? {
    writer: stateWriter(id, store, STATE_INTERVAL_MS, schedule),
    holders: 0,
  };

  held.holders += 1;
  live.set(id, held);
  let released = false;

  return {
    writer: held.writer,
    release: () => {
      if (released) return;
      released = true;
      held.writer.flush();
      held.holders -= 1;

      if (held.holders === 0 && live.get(id) === held) live.delete(id);
    },
  };
};

/** Writes a Visualization's pending state now, before a frame reads it back. */
export const flushState = (id: string) => live.get(id)?.writer.flush();

/** How many Visualizations have a writer held now. */
export const heldWriters = () => live.size;
