import { ConstellationRpcs, ConstellationTransferRpcs } from "@polaris/protocol";
import { Context, Effect, Layer, References, Scope, Stream, Tracer, type Schema } from "effect";
import { RpcGroup, RpcSchema, type Rpc } from "effect/rpc";
import { HostResources } from "../resources/service.ts";
import { BlobChannel } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { CurrentLanguageConnection } from "./currentLanguageConnection.ts";
import { LanguageConnectionLifetime } from "./languageConnectionLifetime.ts";
import { paths } from "../paths.ts";
import { needsConstellationStartup } from "../constellation/composition/startup.ts";
import type { constellationHandlers } from "../constellation/composition/index.ts";
import { ConstellationHarness } from "../constellation/composition/attachments.ts";

/** Protect publication of the cached Exit as well as construction (ADR 0031). */
export const cacheDaemonBuild = <A, E, R>(build: Effect.Effect<A, E, R>) =>
  Effect.cached(build).pipe(Effect.map((load) => load.pipe(Effect.uninterruptible)));

type ConstellationBase = Layer.Services<ReturnType<typeof constellationHandlers>>;

/**
 * Handler implementations own Daemon resources; each invocation retains its request Scope and
 * BlobChannel. A failed build fails each request with `failure`, which must be in its error schema.
 */
export const lazyRpcLayer = <
  R extends Rpc.Any & { readonly successSchema: Schema.Constraint },
  E = never,
  F = E,
>(
  group: RpcGroup.RpcGroup<R>,
  load: Effect.Effect<Context.Context<Rpc.ToHandler<R>>, E>,
  failure?: (tag: string, error: E) => F
) =>
  Layer.effectContext(
    Effect.sync(() => {
      const handlers = new Map<string, Rpc.Handler<R["_tag"]>>();

      for (const rpc of group.requests.values()) {
        const invoke = Effect.fnUntraced(function* (
          payload: Parameters<Rpc.Handler<R["_tag"]>["handler"]>[0],
          options: Parameters<Rpc.Handler<R["_tag"]>["handler"]>[1]
        ) {
          const loaded = yield* failure === undefined
            ? load
            : Effect.mapError(load, (error) => failure(rpc._tag, error));

          const handler = Context.getUnsafe(
            loaded,
            Context.Service<Rpc.Handler<R["_tag"]>>(rpc.key)
          );

          const result = handler.handler(payload, options);

          // The build ran in the first request's fiber: keep its Span and stack frame out of this one.
          const context = Context.omit(
            Scope.Scope,
            BlobChannel,
            CurrentLanguageConnection,
            LanguageConnectionLifetime,
            Tracer.ParentSpan,
            References.CurrentStackFrame
          )(handler.context);

          return Effect.isEffect(result)
            ? Effect.provide(result, context)
            : Stream.provideContext(result, context);
        });
        // SAFETY: the erased Handler contract is created for the same schema and key in group.requests.

        handlers.set(rpc.key, {
          tag: rpc._tag,
          context: Context.empty(),
          handler: (payload, options) =>
            RpcSchema.isStreamSchema(rpc.successSchema)
              ? Stream.unwrap(
                  Effect.map(invoke(payload, options), (result) =>
                    Effect.isEffect(result) ? Stream.fromEffect(result) : result
                  )
                )
              : Effect.flatMap(invoke(payload, options), (result) =>
                  Effect.isEffect(result) ? result : Effect.die("Expected a non-stream RPC result")
                ),
        } as Rpc.Handler<R["_tag"]>);
      }

      return Context.makeUnsafe<Rpc.ToHandler<R>>(handlers);
    })
  );

/** Shared single-flight first-use composition; recovery activates it before requests are served. */
export const lazyConstellationHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<ConstellationBase>();
    const store = yield* EventStore;
    const root = paths().root;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const module = yield* Effect.promise(() => import("../constellation/composition/index.ts"));

        return yield* Layer.buildWithMemoMap(
          module.constellationHandlers(root),
          memoMap,
          scope
        ).pipe(Effect.provide(context), Effect.orDie);
      })
    );

    yield* (yield* ConstellationHarness).defer(Effect.asVoid(load));

    if (yield* needsConstellationStartup(root, yield* store.model)) yield* load;

    return yield* Layer.buildWithMemoMap(
      lazyRpcLayer(ConstellationRpcs.merge(ConstellationTransferRpcs), load),
      memoMap,
      scope
    );
  })
);

/** Resource RPC and worker acquisition share one lazy broker, independent of Constellations. */
export const lazyHostResources = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const store = yield* EventStore;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const module = yield* Effect.promise(() => import("../resources/index.ts"));

        const context = yield* Layer.buildWithMemoMap(module.resourcesLayer, memoMap, scope).pipe(
          Effect.provideService(EventStore, store),
          Effect.orDie
        );

        return Context.get(context, HostResources);
      })
    );

    const model = (yield* store.model).hostResources;

    if (
      [...(model?.leases.values() ?? []), ...(model?.waiting.values() ?? [])].some(
        (l) => l.resource !== "__workers"
      )
    )
      yield* load;

    return Context.make(
      HostResources,
      HostResources.of({
        get: Effect.flatMap(load, (service) => service.get),
        declare: (...args) => Effect.flatMap(load, (service) => service.declare(...args)),
        remove: (...args) => Effect.flatMap(load, (service) => service.remove(...args)),
        release: (...args) => Effect.flatMap(load, (service) => service.release(...args)),
        setWorkerCap: (...args) => Effect.flatMap(load, (service) => service.setWorkerCap(...args)),
        acquire: (...args) => Effect.flatMap(load, (service) => service.acquire(...args)),
        acquireWorker: (...args) =>
          Effect.flatMap(load, (service) => service.acquireWorker(...args)),
      })
    );
  })
);
