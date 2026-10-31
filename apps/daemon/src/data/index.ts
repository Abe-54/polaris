/** Data service interfaces and RPC wiring; discovery and execution replace the stub Layers. */
import {
  DataRpcs,
  DATA_CAPABILITY,
  Unsupported,
  DataError,
  type RequestId,
  type DataSource,
  type SessionId,
  type SchemaTree,
  type TableDetail,
  type QueryResult,
  type QueryLogEntry,
  type WatchDataSources,
  type DescribeData,
  type QueryData,
  type WatchDataQueryLog,
  type SaveDataSource,
  type RemoveDataSource,
  type LabelDataSource,
  type QueryDataStream,
  type QueryDataStreamItem,
  type PageDataQueryLog,
  type DataQueryLogPage,
  type SetDataSourceAccess,
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream, type Redacted } from "effect";
import type { DataConnection } from "./connection.ts";

export type { DataConnection } from "./connection.ts";

import { sources, sourceDependencies } from "./sources.ts";

export { DataSourceAccess } from "./access.ts";

import {
  DataApprovalRequired,
  type DataApprovalOutcome,
  type DataAgentContext,
  type OutsideInput,
} from "./approvalRequired.ts";

type Failure = DataError | Unsupported;

type Input<R extends { readonly payloadSchema: { readonly Type: unknown } }> =
  R["payloadSchema"]["Type"];

const unsupported = () => Effect.fail(new Unsupported({ capability: DATA_CAPABILITY }));

export class DataSources extends Context.Service<
  DataSources,
  {
    readonly list: (input: {
      readonly sessionId: SessionId;
    }) => Effect.Effect<ReadonlyArray<DataSource>, Failure>;
    /** Daemon internal only; always re-read credentials before connecting. */
    readonly resolve: (input: {
      readonly sessionId: SessionId;
      readonly source: string;
    }) => Effect.Effect<
      {
        readonly source: DataSource;
        readonly connection: DataConnection;
        readonly url: Redacted.Redacted<string>;
      },
      Failure
    >;
    readonly watch: (
      input: Input<typeof WatchDataSources>
    ) => Stream.Stream<ReadonlyArray<DataSource>, Failure>;
    readonly save: (input: Input<typeof SaveDataSource>) => Effect.Effect<DataSource, Failure>;
    readonly remove: (input: Input<typeof RemoveDataSource>) => Effect.Effect<void, Failure>;
    readonly access: (
      input: Input<typeof SetDataSourceAccess>
    ) => Effect.Effect<DataSource, Failure>;
    readonly label: (input: Input<typeof LabelDataSource>) => Effect.Effect<DataSource, Failure>;
  }
>()("polaris/daemon/data/DataSources") {
  static readonly layer = Layer.effect(DataSources, Effect.flatMap(sourceDependencies, sources));
}

export class DataQueries extends Context.Service<
  DataQueries,
  {
    readonly describe: (
      input: Input<typeof DescribeData> & DataAgentContext
    ) => Effect.Effect<SchemaTree | TableDetail, Failure | DataApprovalRequired>;
    /** Desktop Queries use the same read-only path as agents, with author `user`. */
    readonly query: (
      input: Input<typeof QueryData> & DataAgentContext
    ) => Effect.Effect<QueryResult, Failure | DataApprovalRequired>;
    readonly awaitApproval: (
      approvalId: RequestId,
      timeoutMs: number
    ) => Effect.Effect<DataApprovalOutcome>;
    readonly recordOutside: (input: OutsideInput) => Effect.Effect<void, Failure>;
    readonly watchLog: (
      input: Input<typeof WatchDataQueryLog>
    ) => Stream.Stream<ReadonlyArray<QueryLogEntry>, Failure>;
    readonly queryStream: (
      input: Input<typeof QueryDataStream>
    ) => Stream.Stream<QueryDataStreamItem, Failure>;
    readonly pageLog: (
      input: Input<typeof PageDataQueryLog>
    ) => Effect.Effect<typeof DataQueryLogPage.Type, Failure>;
  }
>()("polaris/daemon/data/DataQueries") {
  static readonly layer = Layer.succeed(
    DataQueries,
    DataQueries.of({
      awaitApproval: () => Effect.succeed({ status: "pending" }),
      recordOutside: () => Effect.void,
      describe: unsupported,
      query: unsupported,
      watchLog: () => Stream.succeed([]),
      queryStream: () => Stream.fail(new Unsupported({ capability: DATA_CAPABILITY })),
      pageLog: unsupported,
    })
  );
}

export const DataRpcsLive = DataRpcs.toLayer(
  Effect.gen(function* () {
    const sources = yield* DataSources;
    const queries = yield* DataQueries;

    return {
      "data.sources.watch": sources.watch,
      "data.describe": (input) =>
        queries.describe(input).pipe(
          Effect.catchTag("DataApprovalRequired", () =>
            Effect.fail(
              new DataError({
                code: "E-DATA-DENIED",
                message: "This data source needs approval",
                fix: "Approve it in Data (⌘4).",
              })
            )
          )
        ),
      "data.query": (input) =>
        queries.query(input).pipe(
          Effect.catchTag("DataApprovalRequired", () =>
            Effect.fail(
              new DataError({
                code: "E-DATA-DENIED",
                message: "This data source needs approval",
                fix: "Approve it in Data (⌘4).",
              })
            )
          )
        ),
      "data.queryLog.watch": queries.watchLog,
      "data.source.save": sources.save,
      "data.source.remove": sources.remove,
      "data.source.label": sources.label,
      "data.query.stream": (input) => queries.queryStream(input).pipe(Stream.rechunk(1)),
      "data.queryLog.page": queries.pageLog,
      "data.source.access": sources.access,
    };
  })
);
