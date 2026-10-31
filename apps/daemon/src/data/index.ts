/** Data service interfaces and RPC wiring; discovery and execution replace the stub Layers. */
import {
  DataRpcs,
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
import { Context, Effect, Layer, Option, Predicate, Stream, type Redacted } from "effect";
import type { DataConnection } from "./connection.ts";

export type { DataConnection } from "./connection.ts";

import { sources, sourceDependencies } from "./sources.ts";
import { SchemaSnapshots } from "./schemaSnapshots.ts";
import { queries } from "./queries.ts";
import {
  DataApprovalRequired,
  type DataAgentContext,
  type DataApprovalOutcome,
  type OutsideInput,
} from "./approvalRequired.ts";

export { DataSourceAccess } from "./access.ts";

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
  static readonly layer = Layer.effect(DataSources, Effect.flatMap(sourceDependencies, sources));
}

export class DataQueries extends Context.Service<
  DataQueries,
  {
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
    Effect.suspend(() => queries)
  );
}

const wireFailure = (error: Failure | DataApprovalRequired): DataError | Unsupported => {
  if (Predicate.isTagged(error, "Unsupported") || Predicate.isTagged(error, "DataError"))
    return error;

  return new DataError({
    code: "E-DATA-DENIED",
    message: "This data source is unavailable for this request.",
    fix: "Select an agent session and check its data sources.",
  });
};

export const DataRpcsLive = DataRpcs.toLayer(
  Effect.gen(function* () {
    const sources = yield* DataSources;
    const queries = yield* DataQueries;
    const snapshots = yield* Effect.serviceOption(SchemaSnapshots);

    return {
      "data.schemaDiff": (input) =>
        Option.isSome(snapshots)
          ? snapshots.value.get(input)
          : Effect.fail(new Unsupported({ capability: "data.schemaDiff" })),
      "data.sources.watch": (input) => sources.watch(input).pipe(Stream.mapError(wireFailure)),
      "data.describe": (input) => queries.describe(input).pipe(Effect.mapError(wireFailure)),
      "data.query": (input) => queries.query(input).pipe(Effect.mapError(wireFailure)),
      "data.query.stream": (input) =>
        queries.queryStream(input).pipe(Stream.rechunk(1), Stream.mapError(wireFailure)),
      "data.queryLog.page": (input) => queries.pageLog(input).pipe(Effect.mapError(wireFailure)),
      "data.queryLog.watch": (input) => queries.watchLog(input).pipe(Stream.mapError(wireFailure)),
      "data.source.save": (input) => sources.save(input).pipe(Effect.mapError(wireFailure)),
      "data.source.remove": (input) => sources.remove(input).pipe(Effect.mapError(wireFailure)),
      "data.source.label": (input) => sources.label(input).pipe(Effect.mapError(wireFailure)),
      "data.source.access": (input) => sources.access(input).pipe(Effect.mapError(wireFailure)),
    };
  })
);
