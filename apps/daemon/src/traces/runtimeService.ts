import { Context, Effect, Layer } from "effect";
import { join } from "node:path";
import { polarisHome } from "../paths.ts";
import type {
  TraceAvailability,
  TraceError,
  SessionId,
  TurnId,
  TracesSnapshot,
} from "@polaris/protocol";
import type { IngestContext } from "./ingest.ts";

export const TRACE_PORT = 4319;

/** The receiver's port: POLARIS_TRACE_PORT lets a throwaway Daemon run beside the user's. */
export const tracePort = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const port = Number(env.POLARIS_TRACE_PORT);

  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : TRACE_PORT;
};

export type TraceEnvironment = Readonly<Record<string, string | undefined>>;

type TraceSetup = Pick<TracesSnapshot, "availability" | "endpoint" | "userExported">;

export class TraceRuntime extends Context.Service<
  TraceRuntime,
  {
    readonly environment: (
      sessionId: SessionId,
      source: TraceEnvironment,
      launchTurn?: TurnId
    ) => Effect.Effect<Record<string, string>, TraceError>;
    readonly terminalEnvironment: (
      cwd: string,
      source: TraceEnvironment
    ) => Effect.Effect<Record<string, string>, TraceError>;
    readonly launched?: (cwd: string, argv: ReadonlyArray<string>) => Effect.Effect<void>;
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
    Layer.unwrap(
      Effect.promise(() => import("./runtime.ts")).pipe(
        Effect.map((m) => m.traceRuntimeLayerAt(filename, port))
      )
    );
  static readonly layer = Layer.suspend(() =>
    TraceRuntime.layerAt(join(polarisHome(), "trace-tokens.json"))
  );
}
