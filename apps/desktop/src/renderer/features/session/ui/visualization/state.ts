/**
 * Each Visualization's `pv.state` (a slider, a tab), on this device only (ADR 0101): kept in
 * local storage by Visualization id, size-capped, oldest dropped first. It never goes to the agent.
 */
import { Option, Schema } from "effect";

const KEY = "polaris.visualization.state";

/** One Visualization's state, as JSON. */
export const STATE_MAX_BYTES = 16 * 1024;

/** All of them together. */
export const STATES_MAX_BYTES = 512 * 1024;

const Stored = Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String])));

const decode = Schema.decodeUnknownOption(Stored);

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The frame's `pv.state` envelope as JSON text, kept as the frame sent it. */
export interface StateStore {
  readonly load: (id: string) => string | undefined;
  /** False when it is too large to keep. */
  readonly save: (id: string, json: string) => boolean;
}

export const stateStore = (storage: Storage | null): StateStore => {
  // Least recently saved first.
  const read = (): Array<readonly [string, string]> =>
    storage === null ? [] : Option.getOrElse(decode(storage.getItem(KEY)), () => []).slice();

  const write = (entries: ReadonlyArray<readonly [string, string]>) => {
    try {
      storage?.setItem(KEY, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable: the state lasts this mount only.
    }
  };

  return {
    load: (id) => read().find(([key]) => key === id)?.[1],
    save: (id, json) => {
      if (bytes(json) > STATE_MAX_BYTES) return false;
      const entries = [...read().filter(([key]) => key !== id), [id, json] as const];
      let total = entries.reduce((sum, [key, value]) => sum + bytes(key) + bytes(value), 0);

      while (total > STATES_MAX_BYTES && entries.length > 1) {
        const [key, value] = entries.shift() ?? ["", ""];

        total -= bytes(key) + bytes(value);
      }

      write(entries);

      return true;
    },
  };
};

/** The fastest a frame's state reaches storage; a slider dragged faster keeps only its last value. */
export const STATE_SAVE_MS = 500;

export interface StateWriter {
  /** Keeps the latest state that fits, written at most once per `STATE_SAVE_MS`. */
  readonly save: (json: string) => void;
  /** Writes what is pending now (the frame is going away). */
  readonly flush: () => void;
}

export interface Timers<H> {
  readonly setTimeout: (run: () => void, ms: number) => H;
  readonly clearTimeout: (handle: H) => void;
}

export const windowTimers: Timers<number> = {
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export const stateWriter = <H>(store: StateStore, id: string, timers: Timers<H>): StateWriter => {
  let pending: string | null = null;
  let timer: H | null = null;

  const flush = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;

    if (pending !== null) store.save(id, pending);
    pending = null;
  };

  return {
    save: (json) => {
      // An oversized state is never held: the last one that fits stays pending.
      if (bytes(json) > STATE_MAX_BYTES) return;
      pending = json;
      timer ??= timers.setTimeout(flush, STATE_SAVE_MS);
    },
    flush,
  };
};

const local = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export const visualizationStates = stateStore(local());
