import { TraceRuntime } from "./runtimeService.ts";

export { TraceRuntime } from "./runtimeService.ts";

import { dirname } from "node:path";
import { Effect, Layer, Option } from "effect";
import { TraceAvailability, TraceError, type SessionId, type TurnId } from "@polaris/protocol";
import { InspectorTargets } from "./attach/registry.ts";
import { ApprovalPolicy, WorkspaceTrust } from "../services.ts";
import { EventStore } from "../store/EventStore.ts";
import { launchInstrumentation } from "./instrumentation/runtime.ts";
import { applicationProgram } from "./instrumentation/observation.ts";

import { followTokenLifecycle } from "./tokenLifecycle.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceSettings } from "./settings.ts";
import { metricsEndpointFromEnvironment } from "./detection.ts";
import { TraceStore } from "./store.ts";
import { TraceTokenVault, TraceBinding } from "./tokens.ts";
import type { IngestContext } from "./ingest.ts";

export { TRACE_PORT, type TraceEnvironment } from "./runtimeService.ts";

import { TRACE_PORT, type TraceEnvironment } from "./runtimeService.ts";

const tokenError = () =>
  new TraceError({
    code: "E-TRACE-UNAVAILABLE",
    message: "The trace endpoint could not be prepared.",
    fix: "Check permissions in the Daemon's home, then retry.",
  });

export const traceRuntimeLayerAt = (filename: string | null, port = TRACE_PORT) =>
  Layer.effect(
    TraceRuntime,
    Effect.gen(function* () {
      const sessions = yield* TraceSessions;
      const store = yield* TraceStore;
      const settings = yield* Effect.serviceOption(TraceSettings);
      const policy = yield* Effect.serviceOption(ApprovalPolicy);
      const targets = yield* Effect.serviceOption(InspectorTargets);
      const events = yield* Effect.serviceOption(EventStore);

      const instrumentationServices = {
        home: filename === null ? undefined : dirname(filename),
        settings: Option.getOrUndefined(settings),
        trust: Option.getOrUndefined(yield* Effect.serviceOption(WorkspaceTrust)),
        events: Option.getOrUndefined(events),
      };

      const vault = new TraceTokenVault(filename);
      yield* followTokenLifecycle(vault);

      let availability: TraceAvailability = TraceAvailability.cases.Unavailable.make({
        code: "starting",
        message: "The trace receiver is starting.",
        owner: null,
      });

      const vaultCall = <A>(fn: () => A) => Effect.try({ try: fn, catch: tokenError });

      const endpoint = (context: IngestContext, launchTurn?: TurnId | null) =>
        vaultCall(() => {
          const parent = vault.issue(
            TraceBinding.make({
              checkout: context.checkout,
              workspaceId: context.workspaceId,
              sessionId: context.sessionId,
            })
          );

          const token = launchTurn === undefined ? parent : vault.issueLaunch(parent, launchTurn);

          return `http://127.0.0.1:${port}/otlp/${token}`;
        });

      const revokeSession = (id: SessionId) =>
        vaultCall(() => vault.revokeSession(id)).pipe(Effect.ignore, Effect.andThen(store.notify));

      const tracedEnvironment = Effect.fnUntraced(function* (
        id: SessionId,
        source: TraceEnvironment,
        launchTurn?: TurnId
      ) {
        const context = yield* sessions.session(id);

        if (Option.isSome(settings))
          yield* settings.value.prepare(context, source).pipe(Effect.mapError(tokenError));

        const injected = injectedEnvironment(yield* endpoint(context, launchTurn), source);

        const instrumentation = yield* launchInstrumentation(
          context,
          { ...source, ...injected },
          instrumentationServices
        ).pipe(Effect.orElseSucceed(() => ({})));

        return { ...injected, ...instrumentation };
      });

      // Independent of the trace receiver, so attach works while another process holds its port.
      const profileBootstrap = Effect.fnUntraced(function* (
        id: SessionId,
        source: TraceEnvironment,
        traced: TraceEnvironment
      ) {
        const session = Option.isSome(events)
          ? (yield* events.value.model).sessions.get(id)?.session
          : undefined;

        if (
          Option.isNone(targets) ||
          source.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined ||
          source.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT !== undefined ||
          session === undefined ||
          session.permissionMode === "plan" ||
          session.origin === "reviewer" ||
          (Option.isSome(policy) && policy.value.readOnly(id))
        )
          return {};

        return yield* Effect.tryPromise(() =>
          targets.value.environment(id, { ...source, ...traced }.NODE_OPTIONS)
        ).pipe(Effect.orElseSucceed(() => ({})));
      });

      const environment = Effect.fnUntraced(function* (
        id: SessionId,
        source: TraceEnvironment,
        launchTurn?: TurnId
      ) {
        const changed = yield* vaultCall(() => vault.markExported(id, false));

        if (changed) yield* store.notify;

        if (!(yield* sessions.active(id))) return {};

        const traced = TraceAvailability.guards.Listening(availability)
          ? yield* tracedEnvironment(id, source, launchTurn)
          : {};

        return { ...traced, ...(yield* profileBootstrap(id, source, traced)) };
      });

      const authenticate = Effect.fnUntraced(function* (token: string) {
        const binding = yield* vaultCall(() => vault.authenticate(token));

        if (binding === null) return null;

        if (binding.sessionId === null) {
          if (yield* sessions.workspaceActive(binding.workspaceId, binding.checkout))
            return { ...binding, turns: [] } satisfies IngestContext;
        } else if (yield* sessions.active(binding.sessionId)) {
          const context = yield* sessions.session(binding.sessionId);

          if (
            context.checkout === binding.checkout &&
            context.workspaceId === binding.workspaceId
          ) {
            const launchTurn = yield* vaultCall(() => vault.launchedTurn(token));

            const launchedTurn =
              context.turns.find(({ turn }) => turn.id === launchTurn)?.turn ?? null;

            if (launchTurn !== null && launchedTurn === null) return null;

            return { ...context, launchedTurn };
          }
        }

        yield* vaultCall(() => vault.revokeToken(token));

        return null;
      });

      return TraceRuntime.of({
        environment,
        authenticate,
        launched: Effect.fnUntraced(function* (cwd, argv) {
          if (!applicationProgram(argv[0] ?? "", argv.slice(1)) || Option.isNone(settings)) return;
          const context = yield* sessions.workspace(cwd).pipe(Effect.orElseSucceed(() => null));

          if (context !== null) yield* settings.value.recordLaunch(context);
        }),
        revokeSession,
        terminalEnvironment: Effect.fnUntraced(function* (cwd, source) {
          if (!TraceAvailability.guards.Listening(availability)) return {};
          const context = yield* sessions.workspace(cwd);

          if (Option.isSome(settings))
            yield* settings.value.prepare(context, source).pipe(Effect.mapError(tokenError));

          const injected = injectedEnvironment(yield* endpoint(context, null), source);

          const instrumentation = yield* launchInstrumentation(
            context,
            { ...source, ...injected },
            instrumentationServices,
            cwd
          ).pipe(Effect.orElseSucceed(() => ({})));

          return { ...injected, ...instrumentation };
        }),
        checkout: (id) => Effect.map(sessions.session(id), (context) => context.checkout),
        setup: Effect.fnUntraced(function* (id, includeEndpoint = true) {
          const enabled =
            TraceAvailability.guards.Listening(availability) && (yield* sessions.active(id));

          return {
            availability,
            userExported: false,
            endpoint:
              enabled && includeEndpoint ? yield* endpoint(yield* sessions.session(id)) : null,
          };
        }),
        setAvailability: (value) =>
          Effect.sync(() => {
            availability = value;
          }).pipe(Effect.andThen(store.notify)),
      });
    })
  );

const injectedEnvironment = (endpoint: string, source: TraceEnvironment) => {
  const metrics = metricsEndpointFromEnvironment(source);

  const injected = {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
  };

  if (metrics === null) return injected;

  return { ...injected, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: metrics };
};
