import { Context, Effect, Layer } from "effect";
import type {
  DataError,
  NotFound,
  Unsupported,
  DataSchemaDiff,
  SessionId,
  Turn,
  TurnId,
} from "@polaris/protocol";

export class SchemaSnapshots extends Context.Service<
  SchemaSnapshots,
  {
    readonly get: (input: {
      sessionId: SessionId;
      turn?: TurnId;
      turns?: ReadonlyArray<TurnId>;
    }) => Effect.Effect<DataSchemaDiff, DataError>;
    readonly remove: (sessionId: SessionId) => Effect.Effect<void, DataError>;
    readonly begin?: (turn: Turn) => Effect.Effect<void, DataError | NotFound | Unsupported>;
  }
>()("polaris/data/SchemaSnapshots") {
  static readonly layer = Layer.unwrap(
    Effect.promise(() => import("./schemaSnapshots.ts")).pipe(
      Effect.map((module) => module.schemaSnapshotsLayer)
    )
  );
}
