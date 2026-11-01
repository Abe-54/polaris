/** Data over IPC: main wraps the write-only password before forwarding it to the Host. */
import {
  DescribeData,
  GetDataSchemaDiff,
  type DataSchemaDiff,
  QueryData,
  CommitDataEdits,
  type DataWriteResult,
  SaveDataSource,
  SaveDataFileSource,
  RemoveDataSource,
  LabelDataSource,
  QueryDataStream,
  PageDataQueryLog,
  SetDataSourceAccess,
  type QueryDataStreamItem,
  type DataQueryLogPage,
  WatchDataSources,
  WatchDataQueryLog,
  type DataSource,
  type QueryResult,
  type QueryLogEntry,
  type SchemaTree,
  type TableDetail,
} from "@polaris/protocol";
import { Schema } from "effect";

const OnHost = { hostKey: Schema.String.check(Schema.isMinLength(1)) };

export const DataRequestInputs = {
  "data.schemaDiff": Schema.Struct({ ...OnHost, ...GetDataSchemaDiff.payloadSchema.fields }),
  "data.describe": Schema.Struct({ ...OnHost, ...DescribeData.payloadSchema.fields }),
  "data.edits.commit": Schema.Struct({ ...OnHost, ...CommitDataEdits.payloadSchema.fields }),
  "data.query": Schema.Struct({ ...OnHost, ...QueryData.payloadSchema.fields }),
  "data.source.save": Schema.Struct({
    ...OnHost,
    ...SaveDataSource.payloadSchema.fields,
    password: Schema.optionalKey(Schema.String),
  }),
  "data.source.saveFile": Schema.Struct({ ...OnHost, ...SaveDataFileSource.payloadSchema.fields }),
  "data.source.remove": Schema.Struct({ ...OnHost, ...RemoveDataSource.payloadSchema.fields }),
  "data.source.label": Schema.Struct({ ...OnHost, ...LabelDataSource.payloadSchema.fields }),
  "data.queryLog.page": Schema.Struct({ ...OnHost, ...PageDataQueryLog.payloadSchema.fields }),
  "data.source.access": Schema.Struct({ ...OnHost, ...SetDataSourceAccess.payloadSchema.fields }),
} as const;

export interface DataRequestOutputs {
  readonly "data.schemaDiff": DataSchemaDiff;
  readonly "data.describe": SchemaTree | TableDetail;
  readonly "data.edits.commit": DataWriteResult;
  readonly "data.query": QueryResult;
  readonly "data.source.save": DataSource;
  readonly "data.source.saveFile": DataSource;
  readonly "data.source.remove": null;
  readonly "data.source.label": DataSource;
  readonly "data.queryLog.page": typeof DataQueryLogPage.Type;
  readonly "data.source.access": DataSource;
}

export const DataSubscriptionInputs = {
  "data.query.stream": Schema.Struct({ ...OnHost, ...QueryDataStream.payloadSchema.fields }),
  "data.sources.watch": Schema.Struct({ ...OnHost, ...WatchDataSources.payloadSchema.fields }),
  "data.queryLog.watch": Schema.Struct({ ...OnHost, ...WatchDataQueryLog.payloadSchema.fields }),
} as const;

export interface DataSubscriptionItems {
  readonly "data.query.stream": QueryDataStreamItem;
  readonly "data.sources.watch": ReadonlyArray<DataSource>;
  readonly "data.queryLog.watch": ReadonlyArray<QueryLogEntry>;
}
