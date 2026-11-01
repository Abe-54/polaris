import { Context, Effect, Layer, Scope, Stream } from "effect";
import {
  TraceAvailability,
  TraceCompareRpcs,
  TracesRpcs,
  TracesSettingsRpcs,
  ProfilesRpcs,
} from "@polaris/protocol";
import { TraceRuntime } from "../traces/runtimeService.ts";
import { TraceSessions } from "../traces/sessionsService.ts";
import { TraceStore } from "../traces/storeService.ts";
import { Profiles } from "../traces/profiles/service.ts";
import { traceReceiver, type ReceiverOptions } from "../traces/receiver.ts";
import { EventStore } from "../store/EventStore.ts";
import { ApprovalPolicy, WorkspaceTrust } from "../services.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

import type { TraceSettings } from "../traces/settings.ts";

class TraceImplementation extends Context.Service<
  TraceImplementation,
  {
    readonly load: Effect.Effect<
      Context.Context<TraceRuntime | TraceStore | TraceSessions | TraceSettings>
    >;
  }
>()("polaris/traces/Implementation") {}

/** Service contracts stay available to Harnesses and MCP without importing implementations. */
export const lazyTracesAt = (options: Omit<ReceiverOptions, "handler"> = {}) =>
  Layer.fromBuild((memoMap, scope) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<EventStore | ApprovalPolicy | WorkspaceTrust>();

      let availability: TraceAvailability = TraceAvailability.cases.Unavailable.make({
        code: "starting",
        message: "The trace receiver is starting.",
        owner: null,
      });

      let active: TraceRuntime["Service"] | undefined;

      const load = yield* cacheDaemonBuild(
        Effect.gen(function* () {
          const { traceServicesAt } = yield* Effect.promise(
            () => import("../traces/composition.ts")
          );

          const built = yield* Layer.buildWithMemoMap(
            traceServicesAt(options.port),
            memoMap,
            scope
          ).pipe(Effect.provide(context), Effect.orDie);

          active = Context.get(built, TraceRuntime);
          yield* active.setAvailability(availability);

          return built;
        })
      );

      const runtime = Effect.map(load, (built) => Context.get(built, TraceRuntime));
      const store = Effect.map(load, (built) => Context.get(built, TraceStore));

      const sessions = yield* cacheDaemonBuild(
        Effect.gen(function* () {
          const built = yield* Layer.buildWithMemoMap(TraceSessions.layer, memoMap, scope).pipe(
            Effect.provide(context),
            Effect.orDie
          );

          return Context.get(built, TraceSessions);
        })
      );

      const profiles = yield* cacheDaemonBuild(
        Effect.gen(function* () {
          const built = yield* load;

          const result = yield* Layer.buildWithMemoMap(Profiles.layer, memoMap, scope).pipe(
            Effect.provide(Context.merge(context, built)),
            Effect.orDie
          );

          return Context.get(result, Profiles);
        })
      );

      const proxy = TraceRuntime.of({
        environment: (...args) => Effect.flatMap(runtime, (s) => s.environment(...args)),
        // Unregistered terminals cannot emit traces and do not need the runtime or storage.
        terminalEnvironment: (cwd, source) =>
          Effect.suspend(() =>
            TraceAvailability.guards.Listening(availability)
              ? Effect.flatMap(sessions, (s) => s.workspace(cwd)).pipe(
                  Effect.andThen(Effect.flatMap(runtime, (s) => s.terminalEnvironment(cwd, source)))
                )
              : Effect.succeed({})
          ),
        launched: (cwd, argv) =>
          Effect.flatMap(sessions, (s) => s.workspace(cwd)).pipe(
            Effect.andThen(Effect.flatMap(runtime, (s) => s.launched?.(cwd, argv) ?? Effect.void)),
            Effect.ignore
          ),
        authenticate: (token) => Effect.flatMap(runtime, (s) => s.authenticate(token)),
        setup: (...args) => Effect.flatMap(runtime, (s) => s.setup(...args)),
        checkout: (id) => Effect.flatMap(runtime, (s) => s.checkout(id)),
        revokeSession: (id) => Effect.flatMap(runtime, (s) => s.revokeSession(id)),
        setAvailability: (value) =>
          Effect.suspend(() => {
            availability = value;

            return active?.setAvailability(value) ?? Effect.void;
          }),
      });

      const handler = yield* cacheDaemonBuild(
        Effect.gen(function* () {
          const built = yield* load;

          const { traceRequestHandler } = yield* Effect.promise(
            () => import("../traces/receiverHandler.ts")
          );

          return yield* traceRequestHandler(options).pipe(
            Effect.provide(built),
            Effect.provideService(Scope.Scope, scope)
          );
        })
      );

      const proxies = Context.make(TraceRuntime, proxy).pipe(
        Context.add(TraceImplementation, { load }),
        Context.add(
          TraceSessions,
          TraceSessions.of({
            session: (id) => Effect.flatMap(sessions, (s) => s.session(id)),
            workspace: (cwd) => Effect.flatMap(sessions, (s) => s.workspace(cwd)),
            active: (id) => Effect.flatMap(sessions, (s) => s.active(id)),
            workspaceActive: (...args) =>
              Effect.flatMap(sessions, (s) => s.workspaceActive(...args)),
          })
        ),
        Context.add(
          TraceStore,
          TraceStore.of({
            ingest: (input) => Effect.flatMap(store, (s) => s.ingest(input)),
            compare: (...args) => Effect.flatMap(store, (s) => s.compare(...args)),
            list: (...args) => Effect.flatMap(store, (s) => s.list(...args)),
            view: (...args) => Effect.flatMap(store, (s) => s.view(...args)),
            toolList: (...args) => Effect.flatMap(store, (s) => s.toolList(...args)),
            toolSpan: (...args) => Effect.flatMap(store, (s) => s.toolSpan(...args)),
            overlapping: (...args) => Effect.flatMap(store, (s) => s.overlapping(...args)),
            get: (...args) => Effect.flatMap(store, (s) => s.get(...args)),
            span: (...args) => Effect.flatMap(store, (s) => s.span(...args)),
            history: (...args) => Effect.flatMap(store, (s) => s.history(...args)),
            link: (...args) => Effect.flatMap(store, (s) => s.link(...args)),
            watch: (...args) => Stream.unwrap(Effect.map(store, (s) => s.watch(...args))),
            flush: Effect.flatMap(store, (s) => s.flush),
            notify: Effect.flatMap(store, (s) => s.notify),
            workerRunning: Effect.flatMap(store, (s) => s.workerRunning),
          })
        ),
        Context.add(
          Profiles,
          Profiles.of({
            attachUser: (...args) => Effect.flatMap(profiles, (s) => s.attachUser(...args)),
            attach: (...args) => Effect.flatMap(profiles, (s) => s.attach(...args)),
            record: (...args) => Effect.flatMap(profiles, (s) => s.record(...args)),
            capture: (...args) => Effect.flatMap(profiles, (s) => s.capture(...args)),
            restart: (...args) => Effect.flatMap(profiles, (s) => s.restart(...args)),
            get: (...args) => Effect.flatMap(profiles, (s) => s.get(...args)),
            list: (id) => Effect.flatMap(profiles, (s) => s.list(id)),
            watch: (id) => Stream.unwrap(Effect.map(profiles, (s) => s.watch(id))),
          })
        )
      );

      yield* traceReceiver({ ...options, handler }).pipe(
        Effect.provide(proxies),
        Effect.provideService(Scope.Scope, scope)
      );

      return proxies;
    })
  );

export const lazyTraces = lazyTracesAt();

const group = TracesRpcs.merge(TracesSettingsRpcs).merge(TraceCompareRpcs).merge(ProfilesRpcs);

export const lazyTraceHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<TraceRuntime | TraceStore | TraceSessions | Profiles>();
    const implementation = yield* TraceImplementation;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const built = yield* implementation.load;
        const rpcs = yield* Effect.promise(() => import("../traces/rpcs.ts"));
        const profiles = yield* Effect.promise(() => import("../traces/profiles/rpcs.ts"));

        return yield* Layer.buildWithMemoMap(
          Layer.mergeAll(
            rpcs.TracesRpcsLive,
            rpcs.TracesSettingsRpcsLive,
            rpcs.TraceCompareRpcsLive,
            profiles.ProfilesRpcsLive
          ),
          memoMap,
          scope
        ).pipe(Effect.provide(Context.merge(context, built)));
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(group, load), memoMap, scope);
  })
);
