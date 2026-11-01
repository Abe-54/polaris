import { ProfilesRpcs } from "@polaris/protocol";
import { Effect } from "effect";
import { Profiles } from "./index.ts";

export const ProfilesRpcsLive = ProfilesRpcs.toLayer(
  Effect.gen(function* () {
    const profiles = yield* Profiles;

    return {
      "profiles.watch": ({ sessionId }) => profiles.watch(sessionId),
      "profiles.attach": ({ sessionId, pid, seconds }) =>
        profiles.attachUser(sessionId, pid, seconds),
      "profiles.get": ({ sessionId, profileId }) => profiles.get(sessionId, profileId),
      "profiles.restartWithProfiling": ({ sessionId, pid }) => profiles.restart(sessionId, pid),
    };
  })
);
