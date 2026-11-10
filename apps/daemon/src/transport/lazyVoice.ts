import { VoiceRpcs } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import type { BlobChannel } from "../services.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

/**
 * The voice handlers (`voice.*`), with the Deepgram provider and the secrets store they read
 * the user's key from, loaded on the first voice request.
 */
export const lazyVoiceHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<BlobChannel>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const [voice, deepgram, secrets] = yield* Effect.promise(() =>
          Promise.all([
            import("../voice/VoiceRpcs.ts"),
            import("../voice/deepgram.ts"),
            import("../secrets/index.ts"),
          ])
        );

        const layer = voice.VoiceRpcsLive.pipe(
          Layer.provide(Layer.merge(deepgram.DeepgramLive, secrets.HostSecrets.layer))
        );

        return yield* Layer.buildWithMemoMap(layer, memoMap, scope).pipe(Effect.provide(context));
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(VoiceRpcs, load), memoMap, scope);
  })
);
