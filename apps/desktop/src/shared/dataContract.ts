/** Data over IPC: main wraps the write-only password before forwarding it to the Host. */
import {
  DescribeData,
  QueryData,
  SaveDataSource,
  RemoveDataSource,
  LabelDataSource,
  DecideDataApproval,
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
  "data.describe": Schema.Struct({ ...OnHost, ...DescribeData.payloadSchema.fields }),
  "data.query": Schema.Struct({ ...OnHost, ...QueryData.payloadSchema.fields }),
  "data.source.save": Schema.Struct({
    ...OnHost,
    ...SaveDataSource.payloadSchema.fields,
    password: Schema.optionalKey(Schema.String),
  }),
  "data.source.remove": Schema.Struct({ ...OnHost, ...RemoveDataSource.payloadSchema.fields }),
  "data.source.label": Schema.Struct({ ...OnHost, ...LabelDataSource.payloadSchema.fields }),
  "data.approval.decide": Schema.Struct({ ...OnHost, ...DecideDataApproval.payloadSchema.fields }),
} as const;

export interface DataRequestOutputs {
  readonly "data.describe": SchemaTree | TableDetail;
  readonly "data.query": QueryResult;
  readonly "data.source.save": DataSource;
  readonly "data.source.remove": null;
  readonly "data.source.label": DataSource;
  readonly "data.approval.decide": null;
}

export const DataSubscriptionInputs = {
  "data.sources.watch": Schema.Struct({ ...OnHost, ...WatchDataSources.payloadSchema.fields }),
  "data.queryLog.watch": Schema.Struct({ ...OnHost, ...WatchDataQueryLog.payloadSchema.fields }),
} as const;

export interface DataSubscriptionItems {
  readonly "data.sources.watch": ReadonlyArray<DataSource>;
  readonly "data.queryLog.watch": ReadonlyArray<QueryLogEntry>;
}
