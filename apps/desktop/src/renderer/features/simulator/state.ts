/**
 * Each session's Simulator in the renderer: whether it's the Output tab on screen, the dot an
 * agent's Simulator leaves when it isn't, and `simulator.sessionFeed`'s shown Simulator and
 * driving flag. The Simulator the user picked is kept per session across restarts.
 */
import { Option, Schema } from "effect";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export interface SimulatorUi {
  /** The Simulator is the Output tab chosen for this session. */
  readonly shown: boolean;
  /** An agent opened a Simulator while the user was in another Output tab. */
  readonly dot: boolean;
  /** The Daemon's shown Simulator for the session; null for none, or before the feed answers. */
  readonly showing: string | null;
  /** An agent drives the shown Simulator now. */
  readonly driving: boolean;
}

const EMPTY: SimulatorUi = { shown: false, dot: false, showing: null, driving: false };

const store = createStore<Readonly<Record<string, SimulatorUi>>>(() => ({}));

const patch = (key: string, change: (ui: SimulatorUi) => Partial<SimulatorUi>) =>
  store.setState((s) => {
    const current = s[key] ?? EMPTY;

    return { ...s, [key]: { ...current, ...change(current) } };
  });

export const useSimulatorUi = (key: string): SimulatorUi => useStore(store, (s) => s[key] ?? EMPTY);

export const simulatorUi = (key: string): SimulatorUi => store.getState()[key] ?? EMPTY;

/** The Simulator becomes (or stops being) the Output tab on screen; showing it clears its dot. */
export const setSimulatorShown = (key: string, shown: boolean) =>
  patch(key, () => (shown ? { shown, dot: false } : { shown }));

export const markSimulatorActivity = (key: string) => patch(key, () => ({ dot: true }));

export const setShowing = (key: string, showing: string | null) => patch(key, () => ({ showing }));

export const setDriving = (key: string, driving: boolean) => patch(key, () => ({ driving }));

const STORAGE_KEY = "polaris.simulator.picked.v1";

/** Sessions remembered; the least recently picked go first. */
const REMEMBERED = 500;

const decode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
);

const storage = (): Storage | null =>
  "localStorage" in globalThis ? globalThis.localStorage : null;

const load = (): Readonly<Record<string, string>> => {
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;

    return raw === null ? {} : Option.getOrElse(decode(raw), () => ({}));
  } catch {
    return {};
  }
};

const picked = createStore<Readonly<Record<string, string>>>(load);

picked.subscribe((state) => {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable: the pick holds until the app quits.
  }
});

/** The Simulator the user last picked in this session, kept for when the Daemon forgot. */
export const usePickedSimulator = (key: string): string | null =>
  useStore(picked, (s) => s[key] ?? null);

export const rememberPick = (key: string, id: string) =>
  picked.setState((s) => {
    const rest = Object.entries(s).filter(([k]) => k !== key);

    return Object.fromEntries([
      ...rest.slice(Math.max(0, rest.length - REMEMBERED + 1)),
      [key, id],
    ]);
  }, true);
