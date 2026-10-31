/**
 * The hooks Profiles read through, over whichever `ProfilesApi` the nearest `ProfilesLayer`
 * provides: the live IPC one by default, fixtures in previews and tests. Nothing is read on a
 * Host whose Daemon lacks `traces.profiles`.
 */
import type { Profile, ProfileDetail, ProfilesSnapshot } from "@polaris/protocol";
import { createContext, type ReactNode, useContext, useRef } from "react";
import { useProfilesUnavailable } from "../model/availability.ts";
import type { TracesSessionKey } from "../model/session.ts";
import { keyOf, type Loaded, useConnectionOf, useLoadedWith } from "./hooks.tsx";
import { liveProfilesApi, type ProfilesApi } from "./profilesApi.ts";

const ApiContext = createContext<ProfilesApi>(liveProfilesApi);

export const ProfilesLayer = ({ api, children }: { api: ProfilesApi; children: ReactNode }) => (
  <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
);

export const useProfilesApi = () => useContext(ApiContext);

/** Whether the Host is away now, read when an answer fails rather than when the read began. */
const useAway = (connected: boolean) => {
  const away = useRef(!connected);

  away.current = !connected;

  return away;
};

/**
 * The checkout's recordings, live; null while the Host can't record them. The main process ends
 * the watch with the connection, so it opens again on each new epoch; a watch that fails while
 * the Host is away keeps the last list (rule/remote-is-normal).
 */
export const useProfiles = (at: TracesSessionKey): Loaded<ProfilesSnapshot> => {
  const unavailable = useProfilesUnavailable(at.hostKey);
  const { epoch, connected } = useConnectionOf(at.hostKey);
  const away = useAway(connected);

  return useLoadedWith(
    useProfilesApi(),
    unavailable === null ? keyOf(at.hostKey, at.sessionId) : null,
    (api, set) =>
      api.watch(at, {
        next: (value) => set({ status: "ready", value }),
        end: (error) => {
          if (error !== null && !away.current) set({ status: "failed", error });
        },
      }),
    epoch
  );
};

/**
 * One recording parsed; nothing is read while `profile` is null or still recording, since the
 * runtime writes its profile only when it stops. A new `version` (status and duration) or epoch
 * reads it again, keeping the shown chart until the answer comes.
 */
export const useProfile = (
  at: TracesSessionKey,
  profile: Profile | null
): Loaded<ProfileDetail> => {
  const { epoch, connected } = useConnectionOf(at.hostKey);
  const away = useAway(connected);
  const readable = profile !== null && profile.status !== "recording";

  return useLoadedWith(
    useProfilesApi(),
    readable ? keyOf(at.hostKey, at.sessionId, profile.id) : null,
    (api, set) => {
      let live = true;

      if (profile !== null)
        void api.get(at, profile.id).then((result) => {
          if (!live) return;

          if (result.ok) set({ status: "ready", value: result.value });
          else if (!away.current) set({ status: "failed", error: result.error });
        });

      return () => {
        live = false;
      };
    },
    `${epoch}:${profile?.status}:${profile?.durationMs}`
  );
};
