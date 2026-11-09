import { RequestsRpcs } from "@polaris/protocol";
import { Context, Effect, Layer, Scope, Stream } from "effect";
import { FileSearch } from "../files/FileSearch.ts";
import { OriginApprovals } from "../requests/approvals/service.ts";
import { RequestSends, type PreSendHook, type PreSendVerdict } from "../requests/sendsService.ts";
import { EventStore } from "../store/EventStore.ts";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

/**
 * The send engine and Origin Approvals, loaded on the first Send or approval read. Hooks register
 * here without loading; Origin Approvals share Data's `data.sqlite` through the memo map.
 */
export const lazyRequests = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<EventStore | TraceStore | TraceSessions>();
    const hooks = new Set<PreSendHook>();

    const runHooks: PreSendHook = (send) =>
      Effect.gen(function* () {
        for (const hook of hooks) {
          const verdict: PreSendVerdict = yield* hook(send);

          if (!verdict.allow) return verdict;
        }

        return { allow: true } as const;
      });

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { OriginApprovalsLive } = yield* Effect.promise(
          () => import("../requests/approvals/layer.ts")
        );

        const { DataDatabase } = yield* Effect.promise(() => import("../data/database.ts"));

        const built = yield* Layer.buildWithMemoMap(
          Layer.merge(
            RequestSends.layer,
            OriginApprovalsLive.pipe(Layer.provide(DataDatabase.layer))
          ),
          memoMap,
          scope
        ).pipe(Effect.provide(context), Effect.orDie);

        const sends = Context.get(built, RequestSends);
        yield* sends.registerPreSend(runHooks).pipe(Effect.provideService(Scope.Scope, scope));

        return { sends, approvals: Context.get(built, OriginApprovals) };
      })
    );

    const sends = Effect.map(load, (loaded) => loaded.sends);
    const approvals = Effect.map(load, (loaded) => loaded.approvals);

    return Context.make(
      RequestSends,
      RequestSends.of({
        send: (input) => Effect.flatMap(sends, (s) => s.send(input)),
        page: (...args) => Effect.flatMap(sends, (s) => s.page(...args)),
        watch: (checkout) => Stream.unwrap(Effect.map(sends, (s) => s.watch(checkout))),
        get: (...args) => Effect.flatMap(sends, (s) => s.get(...args)),
        registerPreSend: Effect.fnUntraced(function* (hook: PreSendHook) {
          hooks.add(hook);
          yield* Effect.addFinalizer(() => Effect.sync(() => hooks.delete(hook)));
        }),
      })
    ).pipe(
      Context.add(
        OriginApprovals,
        OriginApprovals.of({
          changes: Stream.unwrap(Effect.map(approvals, (a) => a.changes)),
          require: (...args) => Effect.flatMap(approvals, (a) => a.require(...args)),
          awaitApproval: (...args) => Effect.flatMap(approvals, (a) => a.awaitApproval(...args)),
          rules: Effect.flatMap(approvals, (a) => a.rules),
          revoke: (origin) => Effect.flatMap(approvals, (a) => a.revoke(origin)),
        })
      )
    );
  })
);

/** The Requests RPCs load with their first call, over the Daemon's one RequestSends. */
export const lazyRequestHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<EventStore | FileSearch | RequestSends>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { RequestsRpcsLive } = yield* Effect.promise(() => import("../requests/rpcs.ts"));

        return yield* Layer.buildWithMemoMap(RequestsRpcsLive, memoMap, scope).pipe(
          Effect.provide(context)
        );
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(RequestsRpcs, load), memoMap, scope);
  })
);
