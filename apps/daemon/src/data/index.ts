/** Data service interfaces and RPC wiring; discovery and execution replace the stub Layers. */
import {
  DataRpcs,
  DATA_CAPABILITY,
  Unsupported,
  type DataError,
  type NotFound,
  type DataSource,
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
  type DecideDataApproval,
} from "@polaris/protocol";
import { Context, Effect, Layer, Stream } from "effect";

type Failure = DataError | NotFound | Unsupported;

type Input<R extends { readonly payloadSchema: { readonly Type: unknown } }> =
  R["payloadSchema"]["Type"];

const unsupported = () => Effect.fail(new Unsupported({ capability: DATA_CAPABILITY }));

export class DataSources extends Context.Service<
  DataSources,
  {
    readonly watch: (
      input: Input<typeof WatchDataSources>
    ) => Stream.Stream<ReadonlyArray<DataSource>, Failure>;
    readonly save: (input: Input<typeof SaveDataSource>) => Effect.Effect<DataSource, Failure>;
    readonly remove: (input: Input<typeof RemoveDataSource>) => Effect.Effect<void, Failure>;
    readonly label: (input: Input<typeof LabelDataSource>) => Effect.Effect<DataSource, Failure>;
  }
>()("polaris/daemon/data/DataSources") {
  static readonly layer = Layer.succeed(
    DataSources,
    DataSources.of({
      watch: () => Stream.succeed([]),
      save: unsupported,
      remove: unsupported,
      label: unsupported,
    })
  );
}

export class DataQueries extends Context.Service<
  DataQueries,
  {
    readonly describe: (
      input: Input<typeof DescribeData>
    ) => Effect.Effect<SchemaTree | TableDetail, Failure>;
    /** Desktop Queries use the same read-only path as agents, with author `user`. */
    readonly query: (input: Input<typeof QueryData>) => Effect.Effect<QueryResult, Failure>;
    readonly watchLog: (
      input: Input<typeof WatchDataQueryLog>
    ) => Stream.Stream<ReadonlyArray<QueryLogEntry>, Failure>;
    readonly decide: (input: Input<typeof DecideDataApproval>) => Effect.Effect<void, Failure>;
  }
>()("polaris/daemon/data/DataQueries") {
  static readonly layer = Layer.succeed(
    DataQueries,
    DataQueries.of({
      describe: unsupported,
      query: unsupported,
      watchLog: () => Stream.succeed([]),
      decide: unsupported,
    })
  );
}

export const DataRpcsLive = DataRpcs.toLayer(
  Effect.gen(function* () {
    const sources = yield* DataSources;
    const queries = yield* DataQueries;

    return {
      "data.sources.watch": sources.watch,
      "data.describe": queries.describe,
      "data.query": queries.query,
      "data.queryLog.watch": queries.watchLog,
      "data.source.save": sources.save,
      "data.source.remove": sources.remove,
      "data.source.label": sources.label,
      "data.approval.decide": queries.decide,
    };
  })
);
