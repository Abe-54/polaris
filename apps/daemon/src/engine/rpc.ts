/**
 * Handlers for the engine's RPCs: `dispatch`, `subscribeHost`,
 * `subscribeSession`, `session.turns`, `session.terminalCommand`, `review.checkoutStatus` and the auto-archive settings. The transport mounts
 * `EngineRpcHandlers` next to the other modules' handlers when it builds the
 * `DaemonRpcs` server:
 *
 *   RpcServer.layer(DaemonRpcs).pipe(
 *     Layer.provide(EngineRpcHandlers),
 *     Layer.provide(OtherHandlers), ...)
 *
 * The device label for `ApprovalResolved.resolvedBy` comes from the Client's
 * `hello`: the hello handler annotates the connection with
 * `options.client.annotate(DeviceLabel, payload.deviceLabel)`, and the
 * Client's capabilities with `ClientCapabilities` (only Clients that announced
 * `session.live-items` get `ItemProgress` on session streams).
 */
import {
  type Capability,
  DaemonRpcs,
  ExtensionDaemonRpcs,
  NotFound,
  SecretRejected,
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream } from "effect";
import { actorOf, pairingOf } from "../extensions/connection.ts";
import { Engine } from "./Engine.ts";
import { hostItemsFor, sessionItemsFor } from "./limitedCompat.ts";
import { actorHostItemsFor, actorSessionItemsFor } from "./actorCompat.ts";
import { planHostItemsFor, planSessionItemsFor } from "./planCompat.ts";

/** Per-connection annotation set by the `hello` handler. */
export class DeviceLabel extends Context.Service<DeviceLabel, string>()(
  "polaris/daemon/engine/DeviceLabel"
) {}

/** Per-connection annotation set by the `hello` handler: what the Client understands. */
export class ClientCapabilities extends Context.Service<
  ClientCapabilities,
  ReadonlyArray<Capability>
>()("polaris/daemon/engine/ClientCapabilities") {}

export const UNKNOWN_DEVICE = "Unknown device";

/** Everything the Client announced in its `hello`. */
const announcedAll = (annotations: Context.Context<never>): ReadonlyArray<Capability> =>
  Context.getOrUndefined(annotations, ClientCapabilities) ?? [];

/** Whether the Client announced `capability` in its `hello`. */
const announced = (annotations: Context.Context<never>, capability: Capability) =>
  announcedAll(annotations).includes(capability);

/** Both rewrites in order; null when neither applies. */
const composeCompat = <A>(first: ((a: A) => A) | null, second: ((a: A) => A) | null) =>
  first === null ? second : second === null ? first : (a: A) => second(first(a));

const DispatchHandler = ExtensionDaemonRpcs.toLayerHandler(
  "dispatch",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ commandId, command }, { client }) =>
      engine.dispatch({
        commandId,
        command,
        deviceLabel: Context.getOrUndefined(client.annotations, DeviceLabel) ?? UNKNOWN_DEVICE,
        actor: actorOf(client),
        extensionGrant: pairingOf(client)?.grant ?? null,
      });
  })
);

const ProvideSecretHandler = DaemonRpcs.toLayerHandler(
  "secret.provide",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ sessionId, requestId, value }, { client }) =>
      engine
        .provideSecret(
          sessionId,
          requestId,
          value,
          Context.getOrUndefined(client.annotations, DeviceLabel) ?? UNKNOWN_DEVICE
        )
        .pipe(
          Effect.catchTag("ServiceError", () =>
            Effect.fail(
              new SecretRejected({
                reason: "storage",
                message: "The Host couldn't record the answer. Try again.",
              })
            )
          )
        );
  })
);

const SubscribeHostHandler = DaemonRpcs.toLayerHandler(
  "subscribeHost",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ afterSequence }, { client }) => {
      const capabilities = announcedAll(client.annotations);

      const compat = composeCompat(
        composeCompat(hostItemsFor(capabilities), actorHostItemsFor(capabilities)),
        planHostItemsFor(capabilities)
      );

      const items = engine.subscribeHost(afterSequence, {
        subagents: announced(client.annotations, "session.subagents"),
        capabilities,
      });

      return compat === null ? items : Stream.map(items, compat);
    };
  })
);

const SubscribeSessionHandler = DaemonRpcs.toLayerHandler(
  "subscribeSession",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ sessionId, afterSequence, turnLimit }, { client }) => {
      const capabilities = announcedAll(client.annotations);

      const compat = composeCompat(
        composeCompat(sessionItemsFor(capabilities), actorSessionItemsFor(capabilities)),
        planSessionItemsFor(capabilities)
      );

      const items = engine.subscribeSession({
        sessionId,
        afterSequence,
        turnLimit,
        liveItems: announced(client.annotations, "session.live-items"),
        subagents: announced(client.annotations, "session.subagents"),
        capabilities,
      });

      return compat === null ? items : Stream.map(items, compat);
    };
  })
);

const TerminalCommandHandler = DaemonRpcs.toLayerHandler(
  "session.terminalCommand",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ sessionId }) =>
      Effect.gen(function* () {
        if (!(yield* engine.hasSession(sessionId))) {
          return yield* new NotFound({ what: "session", id: sessionId });
        }

        return yield* engine.terminalCommand(sessionId);
      });
  })
);

const ReadTurnsHandler = DaemonRpcs.toLayerHandler(
  "session.turns",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ sessionId, beforeIndex, limit }, { client }) =>
      engine.readTurnPage({
        sessionId,
        beforeIndex,
        limit,
        subagents: announced(client.annotations, "session.subagents"),
      });
  })
);

const CheckoutStatusHandler = DaemonRpcs.toLayerHandler(
  "review.checkoutStatus",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ checkoutId }) => engine.checkoutStatus(checkoutId);
  })
);

const AutoArchiveHandler = DaemonRpcs.toLayerHandler(
  "sessions.autoArchive",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return () => engine.autoArchiveSettings;
  })
);

const SetAutoArchiveHandler = DaemonRpcs.toLayerHandler(
  "sessions.setAutoArchive",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ settings }) => engine.setAutoArchiveSettings(settings);
  })
);

const IdleCompactionHandler = DaemonRpcs.toLayerHandler(
  "sessions.idleCompaction",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return () => engine.idleCompactionSettings;
  })
);

const SetIdleCompactionHandler = DaemonRpcs.toLayerHandler(
  "sessions.setIdleCompaction",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ settings }) => engine.setIdleCompactionSettings(settings);
  })
);

const SuggestedRepliesHandler = DaemonRpcs.toLayerHandler(
  "sessions.suggestedReplies",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return () => engine.suggestedReplies.resolved;
  })
);

const SetSuggestedRepliesHandler = DaemonRpcs.toLayerHandler(
  "sessions.setSuggestedReplies",
  Effect.gen(function* () {
    const engine = yield* Engine;

    return ({ settings }) => engine.suggestedReplies.set(settings);
  })
);

export const EngineRpcHandlers = Layer.mergeAll(
  SuggestedRepliesHandler,
  SetSuggestedRepliesHandler,
  AutoArchiveHandler,
  SetAutoArchiveHandler,
  IdleCompactionHandler,
  SetIdleCompactionHandler,
  DispatchHandler,
  ProvideSecretHandler,
  SubscribeHostHandler,
  SubscribeSessionHandler,
  TerminalCommandHandler,
  ReadTurnsHandler,
  CheckoutStatusHandler
);
