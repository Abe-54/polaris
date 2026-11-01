/**
 * Every connected Host's Developer Mode in main (ENG-709): one `developerMode.watch` per live
 * connection that has the capability. Main's tracers gate on it; the renderer gets each change.
 */
import { DEVELOPER_MODE_CAPABILITY, type DeveloperMode } from "@polaris/protocol";
import type { LiveSession } from "@polaris/client";
import { Effect, Stream } from "effect";

/** What watching reads of a live connection. */
export type WatchSession = Pick<LiveSession, "capabilities"> & {
  readonly client: {
    readonly "developerMode.watch": (
      input: Record<string, never>
    ) => Stream.Stream<DeveloperMode, unknown>;
  };
};

/** Told each Host's new value; null when it is no longer known (disconnected, older Daemon). */
export type DeveloperModeListener = (hostKey: string, mode: DeveloperMode | null) => void;

export interface HostDeveloperModes {
  /** The Host's Developer Mode; null while it isn't connected or its Daemon is older. */
  readonly current: (hostKey: string) => DeveloperMode | null;
  /** Every Host known now, by Host key. */
  readonly all: () => Readonly<Record<string, DeveloperMode>>;
  readonly subscribe: (listener: DeveloperModeListener) => () => void;
  /** Runs until interrupted: follows the Host's connections, and forgets it when it ends. */
  readonly watch: (
    hostKey: string,
    sessions: Stream.Stream<WatchSession | null>
  ) => Effect.Effect<void>;
}

export const makeHostDeveloperModes = (): HostDeveloperModes => {
  const modes = new Map<string, DeveloperMode>();
  const listeners = new Set<DeveloperModeListener>();

  const set = (hostKey: string, mode: DeveloperMode | null) =>
    Effect.sync(() => {
      if (mode === null && !modes.has(hostKey)) return;

      if (mode === null) modes.delete(hostKey);
      else modes.set(hostKey, mode);

      for (const listener of listeners) listener(hostKey, mode);
    });

  const follow = (hostKey: string, session: WatchSession | null) =>
    session === null || !session.capabilities.includes(DEVELOPER_MODE_CAPABILITY)
      ? Stream.fromEffectDrain(set(hostKey, null))
      : Stream.fromEffectDrain(
          session.client["developerMode.watch"]({}).pipe(
            Stream.runForEach((mode) => set(hostKey, mode)),
            Effect.ignore,
            Effect.andThen(set(hostKey, null))
          )
        );

  return {
    current: (hostKey) => modes.get(hostKey) ?? null,
    all: () => Object.fromEntries(modes),
    subscribe: (listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    watch: (hostKey, sessions) =>
      sessions.pipe(
        Stream.switchMap((session) => follow(hostKey, session)),
        Stream.runDrain,
        Effect.ensuring(set(hostKey, null))
      ),
  };
};

/** The app's one registry; `hosts.ts` feeds it, main's tracers and the renderer read it. */
export const hostDeveloperModes: HostDeveloperModes = makeHostDeveloperModes();
