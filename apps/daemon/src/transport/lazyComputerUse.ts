/**
 * Computer use (ENG-846), loaded on first use: the first `computerUse.*` RPC, preview call, or
 * Agent Session asking for `polaris_desktop`. Until then the Daemon holds only these facades.
 */
import { Context, Effect, Layer } from "effect";
import { ComputerUseHostRpcs } from "../computerUse/group.ts";
import type { AskForApp } from "../computerUse/control.ts";
import { PreviewRpcs } from "../computerUse/preview/group.ts";
import type { PreviewTargets } from "../computerUse/preview/targets.ts";
import { DesktopMcp, type RequestComputerUse } from "../harness/desktop/service.ts";
import type { BlobChannel } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

type Live = typeof import("./computerUseLive.ts");

/** The built services, with the module that names them. */
export interface ComputerUseLoaded {
  readonly live: Live;
  readonly context: Context.Context<Layer.Success<Live["computerUseLive"]>>;
}

export class ComputerUseLoads extends Context.Service<
  ComputerUseLoads,
  {
    /** What each session last did with computer use: the tools report it, the preview reads it. */
    readonly targets: Effect.Effect<PreviewTargets["Service"]>;
    readonly services: Effect.Effect<ComputerUseLoaded>;
    /** The Engine's `requestAppApproval`, for `AppControl` now or once it loads. */
    readonly bindApprovals: (ask: AskForApp) => Effect.Effect<void>;
  }
>()("polaris/daemon/transport/ComputerUseLoads") {}

interface Bound {
  ask: AskForApp | null;
  request: RequestComputerUse | null;
  loaded: ComputerUseLoaded | null;
}

/** Hands the Engine's asks to the loaded services; each part is synchronous, so none is missed. */
const bindLoaded = (bound: Bound) => {
  if (bound.loaded === null) return Effect.void;
  const { live, context } = bound.loaded;
  const { ask, request } = bound;

  return Effect.andThen(
    ask === null ? Effect.void : Context.get(context, live.AppControl).bind(ask),
    request === null ? Effect.void : Context.get(context, live.DesktopMcp).bindRequests(request)
  );
};

/** `ComputerUseLoads`, and `DesktopMcp` as a facade that loads computer use for a session. */
export const lazyComputerUse = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const bound: Bound = { ask: null, request: null, loaded: null };

    const targets = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { PreviewTargets } = yield* Effect.promise(
          () => import("../computerUse/preview/targets.ts")
        );

        const built = yield* Layer.buildWithMemoMap(PreviewTargets.layerDaemon, memoMap, scope);

        return Context.get(built, PreviewTargets);
      })
    );

    const services = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const live = yield* Effect.promise(() => import("./computerUseLive.ts"));

        const context = yield* Layer.buildWithMemoMap(live.computerUseLive, memoMap, scope).pipe(
          Effect.provideService(EventStore, store),
          Effect.provideService(live.PreviewTargets, yield* targets),
          Effect.orDie
        );

        const loaded = { live, context };

        yield* Effect.suspend(() => {
          bound.loaded = loaded;

          return bindLoaded(bound);
        });

        return loaded;
      })
    );

    const bindAfter = (set: () => void) =>
      Effect.suspend(() => {
        set();

        return bindLoaded(bound);
      });

    const desktop = DesktopMcp.of({
      forSession: (options) =>
        options.readOnly === true
          ? Effect.succeed(null)
          : services.pipe(
              Effect.flatMap(({ live, context }) =>
                Context.get(context, live.DesktopMcp).forSession(options)
              ),
              Effect.catchCause((cause) =>
                Effect.as(Effect.logWarning("computer use didn't load", cause), null)
              )
            ),
      bindRequests: (request) => bindAfter(() => void (bound.request = request)),
    });

    return Context.make(
      ComputerUseLoads,
      ComputerUseLoads.of({
        targets,
        services,
        bindApprovals: (ask) => bindAfter(() => void (bound.ask = ask)),
      })
    ).pipe(Context.add(DesktopMcp, desktop));
  })
);

/** The Host's `computerUse.*` RPCs over the loaded `ComputerUseHost`. */
export const lazyComputerUseHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const loads = yield* ComputerUseLoads;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { live, context } = yield* loads.services;

        return yield* Layer.buildWithMemoMap(live.ComputerUseHostRpcHandlers, memoMap, scope).pipe(
          Effect.provide(context)
        );
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(ComputerUseHostRpcs, load), memoMap, scope);
  })
);

/** The preview RPCs, loaded with their first call apart from the rest; nothing runs before it. */
export const lazyPreviewHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<BlobChannel | EventStore>();
    const loads = yield* ComputerUseLoads;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { PreviewRpcsLive, PreviewTargets } = yield* Effect.promise(
          () => import("../computerUse/preview/index.ts")
        );

        return yield* Layer.buildWithMemoMap(PreviewRpcsLive, memoMap, scope).pipe(
          Effect.provide(Context.add(context, PreviewTargets, yield* loads.targets))
        );
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(PreviewRpcs, load), memoMap, scope);
  })
);
