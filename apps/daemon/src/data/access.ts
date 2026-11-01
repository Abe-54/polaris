import { Context, Effect, Layer, type Stream } from "effect";
import type { DataSource, SessionId, DataError } from "@polaris/protocol";

import { DataApprovals } from "./approvals.ts";

/** X replaces this policy with remembered Data Source Approvals, keyed by the exact target. */
export class DataSourceAccess extends Context.Service<
  DataSourceAccess,
  {
    readonly changes?: Stream.Stream<void>;
    readonly change?: (
      source: DataSource,
      writes?: DataSource["writes"],
      revoke?: boolean
    ) => Effect.Effect<void, DataError>;
    readonly read: (input: {
      readonly sessionId: SessionId;
      readonly source: DataSource;
    }) => Effect.Effect<Pick<DataSource, "access" | "writes">, DataError>;
  }
>()("polaris/daemon/data/DataSourceAccess") {
  static readonly live = Layer.effect(
    DataSourceAccess,
    Effect.map(DataApprovals, (approvals) => ({
      read: ({ source }) => approvals.read(source),
      change: approvals.change,
      changes: approvals.changes,
    }))
  );
  static readonly layer = Layer.succeed(
    DataSourceAccess,
    DataSourceAccess.of({
      read: ({ source }) =>
        Effect.succeed({
          access: source.locality === "local" ? "read" : "needs-approval",
          writes: "ask",
        }),
    })
  );
}
