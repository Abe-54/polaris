/** Switches per Host kept in device storage, each on by default (see `hostNotifications.ts`). */
import { Option, Schema } from "effect";
import type { PreferenceStorage } from "./preference.ts";

export interface HostSwitches {
  readonly get: (hostId: string) => boolean;
  readonly set: (hostId: string, on: boolean) => void;
  readonly subscribe: (listener: () => void) => () => void;
  /** The Hosts switched off, as a string that changes with any switch. */
  readonly key: () => string;
}

const decodeOff = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** The Hosts stored off; a missing or damaged value leaves every Host on. */
const parseOff = (stored: string | null): ReadonlyArray<string> =>
  stored === null ? [] : Option.getOrElse(decodeOff(stored), () => []);

/** Every Host on until stored off; a Host changed before the load finishes keeps its change. */
export const createHostSwitches = (storage: PreferenceStorage): HostSwitches => {
  const off = new Set<string>();
  const touched = new Set<string>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());

  void storage.load().then((stored) => {
    const loaded = parseOff(stored).filter((id) => !touched.has(id) && !off.has(id));

    if (loaded.length === 0) return;
    loaded.forEach((id) => off.add(id));
    changed();
  });

  return {
    get: (hostId) => !off.has(hostId),
    set: (hostId, on) => {
      touched.add(hostId);

      if (on === !off.has(hostId)) return;

      if (on) off.delete(hostId);
      else off.add(hostId);
      void storage.save(JSON.stringify([...off]));
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    key: () => [...off].sort().join(","),
  };
};
