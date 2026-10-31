import { join } from "node:path";
import { Context, Effect, Layer, Option } from "effect";
import {
  TraceAvailability,
  TraceError,
  type SessionId,
  type TracesSnapshot,
} from "@polaris/protocol";
import { polarisHome } from "../paths.ts";
import { followTokenLifecycle } from "./tokenLifecycle.ts";
import { TraceSessions } from "./sessions.ts";
import { TraceSettings } from "./settings.ts";
import { TraceStore } from "./store.ts";
import { TraceTokenVault, TraceBinding } from "./tokens.ts";
import type { IngestContext } from "./ingest.ts";

export const TRACE_PORT = 4319;

export type TraceEnvironment = Readonly<Record<string, string | undefined>>;

const tokenError = () =>
  new TraceError({
    code: "E-TRACE-UNAVAILABLE",
    message: "The trace endpoint could not be prepared.",
    fix: "Check permissions in the Daemon's home, then retry.",
  });

type TraceSetup = Pick<TracesSnapshot, "availability" | "endpoint" | "userExported">;

export class TraceRuntime extends Context.Service<
  TraceRuntime,
  {
    readonly environment: (
      sessionId: SessionId,
      source: TraceEnvironment
    ) => Effect.Effect<Record<string, string>, TraceError>;
    readonly terminalEnvironment: (
      cwd: string,
      source: TraceEnvironment
    ) => Effect.Effect<Record<string, string>, TraceError>;
    readonly authenticate: (token: string) => Effect.Effect<IngestContext | null, TraceError>;
    readonly setup: (
      sessionId: SessionId,
      includeEndpoint?: boolean
    ) => Effect.Effect<TraceSetup, TraceError>;
    readonly checkout: (sessionId: SessionId) => Effect.Effect<string, TraceError>;
    readonly revokeSession: (sessionId: SessionId) => Effect.Effect<void>;
    readonly setAvailability: (value: TraceAvailability) => Effect.Effect<void>;
  }
>()("polaris/traces/Runtime") {
  static layerAt = (filename: string | null, port = TRACE_PORT) =>
    Layer.effect(
      TraceRuntime,
      Effect.gen(function* () {
        const sessions = yield* TraceSessions;
        const store = yield* TraceStore;
        const settings = yield* Effect.serviceOption(TraceSettings);
        const vault = new TraceTokenVault(filename);
        yield* followTokenLifecycle(vault);

        let availability: TraceAvailability = TraceAvailability.cases.Unavailable.make({
          code: "starting",
          message: "The trace receiver is starting.",
          owner: null,
        });

        const vaultCall = <A>(fn: () => A) => Effect.try({ try: fn, catch: tokenError });

        const endpoint = (context: IngestContext) =>
          vaultCall(() => {
            const token = vault.issue(
              TraceBinding.make({
                checkout: context.checkout,
                workspaceId: context.workspaceId,
                sessionId: context.sessionId,
              })
            );

            return `http://127.0.0.1:${port}/otlp/${token}`;
          });

        const revokeSession = (id: SessionId) =>
          vaultCall(() => vault.revokeSession(id)).pipe(
            Effect.ignore,
            Effect.andThen(store.notify)
          );

        const environment = Effect.fnUntraced(function* (id: SessionId, source: TraceEnvironment) {
          const changed = yield* vaultCall(() => vault.markExported(id, false));

          if (changed) yield* store.notify;

          if (!TraceAvailability.guards.Listening(availability)) return {};

          if (!(yield* sessions.active(id))) return {};
          const context = yield* sessions.session(id);

          if (Option.isSome(settings))
            yield* settings.value.prepare(context, source).pipe(Effect.mapError(tokenError));

          return injectedEnvironment(yield* endpoint(context));
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
            )
              return context;
          }

          yield* vaultCall(() => vault.revokeToken(token));

          return null;
        });

        return TraceRuntime.of({
          environment,
          authenticate,
          revokeSession,
          terminalEnvironment: Effect.fnUntraced(function* (cwd, source) {
            if (!TraceAvailability.guards.Listening(availability)) return {};
            const context = yield* sessions.workspace(cwd);

            if (Option.isSome(settings))
              yield* settings.value.prepare(context, source).pipe(Effect.mapError(tokenError));

            return injectedEnvironment(yield* endpoint(context));
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

  static readonly layer = Layer.suspend(() =>
    TraceRuntime.layerAt(join(polarisHome(), "trace-tokens.json"))
  );
}

const injectedEnvironment = (endpoint: string) => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
});
