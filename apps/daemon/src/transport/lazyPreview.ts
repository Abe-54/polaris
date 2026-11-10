import { Effect, Layer } from "effect";
import { PreviewRpcs } from "../computerUse/preview/group.ts";
import type { PreviewTargets } from "../computerUse/preview/targets.ts";
import type { BlobChannel } from "../services.ts";
import type { EventStore } from "../store/EventStore.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

/** The computer use preview RPCs (ENG-846) load with their first call; nothing runs before it. */
export const lazyPreviewHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<BlobChannel | EventStore | PreviewTargets>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { PreviewRpcsLive } = yield* Effect.promise(
          () => import("../computerUse/preview/index.ts")
        );

        return yield* Layer.buildWithMemoMap(PreviewRpcsLive, memoMap, scope).pipe(
          Effect.provide(context)
        );
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(PreviewRpcs, load), memoMap, scope);
  })
);
