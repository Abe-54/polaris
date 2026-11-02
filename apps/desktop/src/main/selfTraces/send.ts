/** Sends a Self-Trace batch to a Host with `traces.ingestSelf`, untraced so it never feeds itself. */
import type { SelfTraceSendOutcome } from "@polaris/client";
import { SELF_TRACES_CAPABILITY, type SelfTraceBatch } from "@polaris/protocol";
import { Effect } from "effect";
import { HostDirectory } from "../hosts.ts";

const outcome = (value: SelfTraceSendOutcome) => () => Effect.succeed(value);

/** A Host that is gone or never connected is unreachable; one that refuses drops the batch. */
export const ingestOn = (
  hostKey: string,
  batch: SelfTraceBatch
): Effect.Effect<SelfTraceSendOutcome, never, HostDirectory> =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session),
    Effect.flatMap((session) =>
      session.capabilities.includes(SELF_TRACES_CAPABILITY)
        ? session.client["traces.ingestSelf"](batch).pipe(Effect.as<SelfTraceSendOutcome>("sent"))
        : Effect.succeed<SelfTraceSendOutcome>("dropped")
    ),
    Effect.catchTags({
      UnknownHost: outcome("unreachable"),
      NotConnected: outcome("unreachable"),
      RpcClientError: outcome("unreachable"),
      Unsupported: outcome("dropped"),
      SelfTraceRejected: (error) =>
        Effect.succeed<SelfTraceSendOutcome>(error.reason === "busy" ? "unreachable" : "dropped"),
    }),
    Effect.withTracerEnabled(false)
  );
