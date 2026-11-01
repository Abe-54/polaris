import { Context, Effect, Layer, type Stream, type Scope } from "effect";
import { join } from "node:path";
import { polarisHome } from "../../paths.ts";
import type { SessionId, Profile, ProfileDetail, ProfileId, ProfileError } from "@polaris/protocol";
import type { ProfileOptions, ProfileRecording, ProfileRecordingMeta } from "./index.ts";

export class Profiles extends Context.Service<
  Profiles,
  {
    readonly attachUser: (
      sessionId: SessionId,
      pid: number,
      seconds?: number
    ) => Effect.Effect<Profile, ProfileError>;
    readonly attach: (
      sessionId: SessionId,
      pid: number,
      seconds?: number
    ) => Effect.Effect<Profile, ProfileError>;
    readonly record: (
      sessionId: SessionId,
      meta: ProfileRecordingMeta
    ) => Effect.Effect<ProfileRecording, ProfileError, Scope.Scope>;
    readonly capture: (
      sessionId: SessionId,
      argv: ReadonlyArray<string>,
      waitSeconds?: number
    ) => Effect.Effect<Profile, ProfileError>;
    readonly restart: (sessionId: SessionId, pid: number) => Effect.Effect<Profile, ProfileError>;
    readonly get: (
      sessionId: SessionId,
      id: ProfileId
    ) => Effect.Effect<ProfileDetail, ProfileError>;
    readonly list: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Profile>, ProfileError>;
    readonly watch: (
      sessionId: SessionId
    ) => Stream.Stream<{ profiles: ReadonlyArray<Profile> }, ProfileError>;
  }
>()("polaris/traces/Profiles") {
  static layerAt = (root: string, options: ProfileOptions = {}) =>
    Layer.unwrap(
      Effect.promise(() => import("./index.ts")).pipe(
        Effect.map((m) => m.profilesLayerAt(root, options))
      )
    );
  static readonly layer = Layer.suspend(() => Profiles.layerAt(join(polarisHome(), "profiles")));
}
