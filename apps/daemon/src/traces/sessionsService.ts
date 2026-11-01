import { Context, Effect, Layer } from "effect";
import type { SessionId, WorkspaceId, TraceError } from "@polaris/protocol";
import type { IngestContext } from "./ingest.ts";

export class TraceSessions extends Context.Service<
  TraceSessions,
  {
    readonly session: (id: SessionId) => Effect.Effect<IngestContext, TraceError>;
    readonly workspace: (cwd: string) => Effect.Effect<IngestContext, TraceError>;
    readonly active: (id: SessionId) => Effect.Effect<boolean>;
    readonly workspaceActive: (id: WorkspaceId, checkout: string) => Effect.Effect<boolean>;
  }
>()("polaris/traces/Sessions") {
  static readonly layer = Layer.unwrap(
    Effect.promise(() => import("./sessions.ts")).pipe(Effect.map((m) => m.traceSessionsLayer))
  );
}
