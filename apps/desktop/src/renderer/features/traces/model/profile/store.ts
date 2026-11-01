/**
 * The Profile open in each Agent Session's Traces, its selected frame and the flame chart's
 * shown range, kept while the user moves around. The summary is the sidebar's latest copy.
 */
import type { Profile } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { TracesSessionKey } from "../session.ts";
import type { FlameWindow } from "./flame.ts";

export interface ProfileSelection {
  readonly profile: Profile | null;
  /** A node index in the open Profile's detail. */
  readonly frame: number | null;
  /** Null shows the whole recording. */
  readonly window: FlameWindow | null;
}

const NONE: ProfileSelection = { profile: null, frame: null, window: null };

const store = createStore<Readonly<Record<string, ProfileSelection>>>(() => ({}));

const keyOf = (at: TracesSessionKey) => `${at.hostKey}\u0000${at.sessionId}`;

const update = (at: TracesSessionKey, change: (s: ProfileSelection) => ProfileSelection) =>
  store.setState((s) => ({ ...s, [keyOf(at)]: change(s[keyOf(at)] ?? NONE) }));

/** Opens a Profile with the whole recording shown; null closes it. */
export const selectProfile = (at: TracesSessionKey, profile: Profile | null) =>
  update(at, () => ({ ...NONE, profile }));

/** Keeps the open Profile's summary current as the list changes (a recording finishing). */
export const refreshProfile = (at: TracesSessionKey, profiles: ReadonlyArray<Profile>) =>
  update(at, (s) => {
    const fresh = profiles.find((p) => p.id === s.profile?.id);

    return fresh === undefined || fresh === s.profile ? s : { ...s, profile: fresh };
  });

export const selectFrame = (at: TracesSessionKey, frame: number | null) =>
  update(at, (s) => ({ ...s, frame }));

export const setFlameWindow = (at: TracesSessionKey, window: FlameWindow | null) =>
  update(at, (s) => ({ ...s, window }));

export const profileSelection = (at: TracesSessionKey): ProfileSelection =>
  store.getState()[keyOf(at)] ?? NONE;

export const useProfileSelection = (at: TracesSessionKey): ProfileSelection =>
  useStore(store, (s) => s[keyOf(at)] ?? NONE);

const focus = createStore<Readonly<Record<string, boolean>>>(() => ({}));

/** Whether focus is in the open Profile's panel; the trace bar leaves ⌘L to it meanwhile. */
export const setProfileFocused = (at: TracesSessionKey, focused: boolean) =>
  focus.setState((s) => (s[keyOf(at)] === focused ? s : { ...s, [keyOf(at)]: focused }));

export const useProfileFocused = (at: TracesSessionKey): boolean =>
  useStore(focus, (s) => s[keyOf(at)] ?? false);
