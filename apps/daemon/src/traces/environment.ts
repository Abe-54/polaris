import type { SessionId } from "@polaris/protocol";
import { Effect, Option } from "effect";
import { TraceRuntime, type TraceEnvironment } from "./runtimeService.ts";

/** Only endpoint variables cross reviewer allowlists; exporter headers and vendor credentials do not. */
export const traceEndpointEnvironment = (source: TraceEnvironment) => {
  const result: Record<string, string> = {};

  for (const key of [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ] as const)
    if (source[key] !== undefined) result[key] = source[key];

  return result;
};

/** Harness retirement is not session revocation; unavailable tracing never prevents a session. */
export const sessionTraceEnvironment = Effect.fnUntraced(function* (
  sessionId: SessionId,
  source: TraceEnvironment
) {
  const runtime = yield* Effect.serviceOption(TraceRuntime);

  if (Option.isNone(runtime)) return {};

  const env = yield* runtime.value
    .environment(sessionId, source)
    .pipe(Effect.orElseSucceed(() => ({})));

  return env;
});
