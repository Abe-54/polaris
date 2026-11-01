/** Data service interfaces and RPC wiring; discovery and execution replace the stub Layers. */
import {
  type ExecuteDataInput,
  type CommitDataEdits,
  type DataWriteResult,
  Unsupported,
  DataError,
  type RequestId,
  type QueryDataStream,
  type QueryDataStreamItem,
  type PageDataQueryLog,
  type DataQueryLogPage,
  type SetDataSourceAccess,
  type NotFound,
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
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream, type Redacted } from "effect";
import type { DataConnection } from "./connection.ts";

export type { DataConnection } from "./connection.ts";

import {
  type DataApprovalRequired,
  type DataAgentContext,
  type DataApprovalOutcome,
  type OutsideInput,
} from "./approvalRequired.ts";

type Failure = DataError | NotFound | Unsupported;

type Input<R extends { readonly payloadSchema: { readonly Type: unknown } }> =
  R["payloadSchema"]["Type"];

export class DataSources extends Context.Service<
  DataSources,
  {
    readonly list: (input: {
      readonly sessionId: SessionId;
    }) => Effect.Effect<ReadonlyArray<DataSource>, Failure>;
    /** Explicitly re-list and notify open watches; call before showing a source approval. */
    readonly refresh: (input: {
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
        /** Matching only. Never pass this URL to a driver; use connection. */
        readonly matchUrl: Redacted.Redacted<string>;
      },
      Failure
    >;
    readonly inspect?: (
      source: DataSource,
      connection: DataConnection
    ) => Effect.Effect<void, DataError>;
    readonly watch: (
      input: Input<typeof WatchDataSources>
    ) => Stream.Stream<ReadonlyArray<DataSource>, Failure>;
    readonly save: (input: Input<typeof SaveDataSource>) => Effect.Effect<DataSource, Failure>;
    readonly remove: (input: Input<typeof RemoveDataSource>) => Effect.Effect<void, Failure>;
    readonly label: (input: Input<typeof LabelDataSource>) => Effect.Effect<DataSource, Failure>;
    readonly access: (
      input: Input<typeof SetDataSourceAccess>
    ) => Effect.Effect<DataSource, Failure>;
  }
>()("polaris/daemon/data/DataSources") {
  static readonly layer = Layer.effect(
    DataSources,
    Effect.gen(function* () {
      const { sourceDependencies, sources } = yield* Effect.promise(() => import("./sources.ts"));

      return yield* Effect.flatMap(sourceDependencies, sources);
    })
  );
}

export class DataQueries extends Context.Service<
  DataQueries,
  {
    readonly execute: (
      input: typeof ExecuteDataInput.Type & DataAgentContext
    ) => Effect.Effect<DataWriteResult, Failure | DataApprovalRequired>;
    readonly commitEdits: (
      input: Input<typeof CommitDataEdits>
    ) => Effect.Effect<DataWriteResult, Failure>;
    readonly describe: (
      input: Input<typeof DescribeData> & DataAgentContext
    ) => Effect.Effect<SchemaTree | TableDetail, Failure | DataApprovalRequired>;
    readonly query: (
      input: Input<typeof QueryData> & DataAgentContext
    ) => Effect.Effect<QueryResult, Failure | DataApprovalRequired>;
    readonly queryStream: (
      input: Input<typeof QueryDataStream>
    ) => Stream.Stream<QueryDataStreamItem, Failure | DataApprovalRequired>;
    readonly watchLog: (
      input: Input<typeof WatchDataQueryLog>
    ) => Stream.Stream<ReadonlyArray<QueryLogEntry>, Failure>;
    readonly pageLog: (
      input: Input<typeof PageDataQueryLog>
    ) => Effect.Effect<typeof DataQueryLogPage.Type, Failure>;
    readonly awaitApproval: (
      id: RequestId,
      timeoutMs: number
    ) => Effect.Effect<DataApprovalOutcome>;
    readonly recordOutside: (input: OutsideInput) => Effect.Effect<void, Failure>;
  }
>()("polaris/daemon/data/DataQueries") {
  static readonly layer = Layer.effect(
    DataQueries,
    Effect.gen(function* () {
      const { queries } = yield* Effect.promise(() => import("./queries.ts"));

      return yield* queries;
    })
  );
}
