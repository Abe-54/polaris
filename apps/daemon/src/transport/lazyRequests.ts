import { RequestsRpcs } from "@polaris/protocol";
import { Effect, Layer } from "effect";
import { FileSearch } from "../files/FileSearch.ts";
import { EventStore } from "../store/EventStore.ts";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

/** Requests load with their first RPC: the handlers, the send engine and its Send Log. */
export const lazyRequestHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<EventStore | FileSearch | TraceStore | TraceSessions>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { RequestsRpcsLive } = yield* Effect.promise(() => import("../requests/rpcs.ts"));
        const { RequestSends } = yield* Effect.promise(() => import("../requests/sendsService.ts"));

        return yield* Layer.buildWithMemoMap(
          RequestsRpcsLive.pipe(Layer.provide(RequestSends.layer)),
          memoMap,
          scope
        ).pipe(Effect.provide(context), Effect.orDie);
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(RequestsRpcs, load), memoMap, scope);
  })
);
