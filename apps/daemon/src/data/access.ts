import { Context, Effect, Layer } from "effect";
import type { DataSource, SessionId, DataError } from "@polaris/protocol";

/** X replaces this policy with remembered Data Source Approvals, keyed by the exact target. */
export class DataSourceAccess extends Context.Service<
  DataSourceAccess,
  {
    readonly read: (input: {
      readonly sessionId: SessionId;
      readonly source: DataSource;
    }) => Effect.Effect<Pick<DataSource, "access" | "writes">, DataError>;
  }
>()("polaris/daemon/data/DataSourceAccess") {
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
