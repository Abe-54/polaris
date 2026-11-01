/**
 * "Restart ‹service› with profiling" per Agent Session, kept outside the sidebar so a tab switch
 * doesn't forget a restart in flight: each target's state by `service:pid`, and the recordings
 * this window asked for, which are the user's.
 */
import type { Profile, ProfileId } from "@polaris/protocol";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { IpcError, Result } from "../../../../../shared/api.ts";
import type { TracesSessionKey } from "../session.ts";
import type { RestartTarget } from "./restart.ts";

export type Restart =
  | { readonly kind: "idle" | "pending" }
  | { readonly kind: "refused"; readonly error: IpcError };

interface SessionRestarts {
  readonly byTarget: Readonly<Record<string, Restart>>;
  readonly requested: ReadonlySet<ProfileId>;
}

const NONE: SessionRestarts = { byTarget: {}, requested: new Set() };

const IDLE: Restart = { kind: "idle" };

const store = createStore<Readonly<Record<string, SessionRestarts>>>(() => ({}));

const sessionKey = (at: TracesSessionKey) => `${at.hostKey}\u0000${at.sessionId}`;

const targetKey = (target: RestartTarget) => `${target.service}:${target.pid}`;

const update = (at: TracesSessionKey, change: (s: SessionRestarts) => SessionRestarts) =>
  store.setState((s) => ({ ...s, [sessionKey(at)]: change(s[sessionKey(at)] ?? NONE) }));

const setRestart = (at: TracesSessionKey, target: RestartTarget, restart: Restart) =>
  update(at, (s) => ({ ...s, byTarget: { ...s.byTarget, [targetKey(target)]: restart } }));

/**
 * Restarts `target` unless a restart of it is already in flight; on success the new recording is
 * marked as the user's and handed to `opened`.
 */
export const startRestart = (
  at: TracesSessionKey,
  target: RestartTarget,
  send: () => Promise<Result<Profile>>,
  opened: (profile: Profile) => void
) => {
  if (restartOf(at, target).kind === "pending") return;
  setRestart(at, target, { kind: "pending" });

  void send().then((result) => {
    if (!result.ok) {
      setRestart(at, target, { kind: "refused", error: result.error });

      return;
    }

    update(at, (s) => ({
      byTarget: { ...s.byTarget, [targetKey(target)]: IDLE },
      requested: new Set([...s.requested, result.value.id]),
    }));
    opened(result.value);
  });
};

export const restartOf = (at: TracesSessionKey, target: RestartTarget): Restart =>
  store.getState()[sessionKey(at)]?.byTarget[targetKey(target)] ?? IDLE;

export const useRestart = (at: TracesSessionKey, target: RestartTarget | null): Restart =>
  useStore(store, (s) =>
    target === null ? IDLE : (s[sessionKey(at)]?.byTarget[targetKey(target)] ?? IDLE)
  );

/** Whether this window asked for the recording, so the user made it. */
export const useRequestedHere = (at: TracesSessionKey, id: ProfileId): boolean =>
  useStore(store, (s) => s[sessionKey(at)]?.requested.has(id) ?? false);

/** Forgets every session's restarts; tests share this store. */
export const resetRestarts = () => store.setState({}, true);
