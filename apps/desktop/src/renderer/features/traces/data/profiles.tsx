/**
 * The hooks Profiles read through, over whichever `ProfilesApi` the nearest `ProfilesLayer`
 * provides: the live IPC one by default, fixtures in previews and tests. Nothing is read on a
 * Host whose Daemon lacks `traces.profiles`.
 */
import type { ProfileDetail, ProfileId, ProfilesSnapshot } from "@polaris/protocol";
import { createContext, type ReactNode, useContext } from "react";
import { useProfilesUnavailable } from "../model/availability.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { keyOf, type Loaded, settle, useLoadedWith } from "./hooks.tsx";
import { liveProfilesApi, type ProfilesApi } from "./profilesApi.ts";

const ApiContext = createContext<ProfilesApi>(liveProfilesApi);

export const ProfilesLayer = ({ api, children }: { api: ProfilesApi; children: ReactNode }) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useProfilesApi = () => useContext(ApiContext);

/** The checkout's recordings, live; null while the Host can't record them. */
export const useProfiles = (at: TracesSessionKey): Loaded<ProfilesSnapshot> => {
  const unavailable = useProfilesUnavailable(at.hostKey);

  return useLoadedWith(
    useProfilesApi(),
    unavailable === null ? keyOf(at.hostKey, at.sessionId) : null,
    (api, set) =>
      api.watch(at, {
        next: (value) => set({ status: "ready", value }),
        end: (error) => {
          if (error !== null) set({ status: "failed", error });
        },
      })
  );
};

/**
 * One recording parsed; nothing is read while `profileId` is null. `version` (its status and
 * duration) reads it again as a recording grows or finishes.
 */
export const useProfile = (
  at: TracesSessionKey,
  profileId: ProfileId | null,
  version: string
): Loaded<ProfileDetail> =>
  useLoadedWith(
    useProfilesApi(),
    profileId === null ? null : keyOf(at.hostKey, at.sessionId, profileId, version),
    // A null id has a null key, so this never reads without one.
    settle<ProfileDetail, ProfilesApi>((api) =>
      profileId === null ? new Promise(() => undefined) : api.get(at, profileId)
    )
  );
