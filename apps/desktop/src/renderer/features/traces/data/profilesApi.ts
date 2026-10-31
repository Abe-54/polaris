/**
 * Profiles' boundary (ADR 0094): `profiles.watch`, `profiles.get` and
 * `profiles.restartWithProfiling`, typed by the protocol alone; fixtures swap in for previews.
 */
import type { Profile, ProfileDetail, ProfileId, ProfilesSnapshot } from "@polaris/protocol";
import type { IpcError, Result } from "../../../../shared/api.ts";
import { polaris } from "../../bridge.ts";
import type { TracesSessionKey } from "../model/session.ts";

export interface ProfileSnapshots {
  /** The latest list; each one replaces the last. */
  readonly next: (snapshot: ProfilesSnapshot) => void;
  readonly end?: (error: IpcError | null) => void;
}

export interface ProfilesApi {
  /** The checkout's recordings, newest first; the returned function stops watching. */
  readonly watch: (at: TracesSessionKey, on: ProfileSnapshots) => () => void;
  /** One recording parsed: its functions and flame chart nodes. */
  readonly get: (at: TracesSessionKey, profileId: ProfileId) => Promise<Result<ProfileDetail>>;
  /** Restarts a process Polaris launched with profiling on; the Daemon refuses any other. */
  readonly restart: (at: TracesSessionKey, pid: number) => Promise<Result<Profile>>;
}

const session = (at: TracesSessionKey) => ({ hostKey: at.hostKey, sessionId: at.sessionId });

export const liveProfilesApi: ProfilesApi = {
  watch: (at, on) =>
    polaris().subscribe("profiles.watch", session(at), {
      items: (items) => {
        const last = items.at(-1);

        if (last !== undefined) on.next(last);
      },
      end: (error) => on.end?.(error),
    }),
  get: (at, profileId) => polaris().request("profiles.get", { ...session(at), profileId }),
  restart: (at, pid) => polaris().request("profiles.restartWithProfiling", { ...session(at), pid }),
};
