/** Data Sources and Queries (ADR 0091, ENG-644). Credentials never appear in results. */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported, NotFound } from "./errors.ts";
import { RequestId, SessionId, Timestamp, TurnId } from "./ids.ts";

export const DATA_CAPABILITY = "data";

const Name = Schema.String.check(Schema.isMinLength(1));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DataEngine = Schema.Literals(["postgres", "mysql"]);

export const DataSourceLabel = Schema.Struct({
  text: Schema.String,
  colour: Schema.Literals(["none", "grey", "green", "blue", "tan", "red"]),
});

export type DataSourceLabel = typeof DataSourceLabel.Type;

export class DataSource extends Schema.Class<DataSource>("DataSource")({
  /** Stable hash of checkout path and source name, assigned by discovery. */
  id: Name,
  name: Name,
  engine: DataEngine,
  version: Schema.optionalKey(Schema.String),
  locality: Schema.Literals(["local", "remote"]),
  branch: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.Literals(["planetscale", "neon"]),
      name: Name,
    })
  ),
  host: Name,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  database: Name,
  user: Schema.optionalKey(Schema.String),
  foundIn: Schema.Struct({
    kind: Schema.Literals(["env", "framework", "compose", "manual"]),
    file: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.String),
  }),
  access: Schema.Literals(["read", "needs-approval", "approved", "denied"]),
  writes: Schema.Literals(["ask", "off"]),
  label: DataSourceLabel,
  reachable: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
}) {}

export class QueryResult extends Schema.Class<QueryResult>("QueryResult")({
  queryId: Name,
  columns: Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String })),
  /** JSON wire values; database numerics retain their returned representation. */
  rows: Schema.Array(Schema.Array(Schema.Unknown)),
  rowCount: Count,
  truncated: Schema.Boolean,
  elapsedMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class TableSummary extends Schema.Class<TableSummary>("TableSummary")({
  name: Name,
  rowEstimate: Schema.NullOr(Count),
  columnCount: Count,
}) {}

export class TableDetail extends Schema.Class<TableDetail>("TableDetail")({
  schema: Name,
  name: Name,
  columns: Schema.Array(
    Schema.Struct({
      name: Name,
      type: Schema.String,
      nullable: Schema.Boolean,
      default: Schema.NullOr(Schema.String),
      pk: Schema.Boolean,
      fk: Schema.NullOr(Schema.Struct({ schema: Name, table: Name, column: Name })),
    })
  ),
  indexes: Schema.Array(
    Schema.Struct({
      name: Name,
      columns: Schema.Array(Schema.String),
      unique: Schema.Boolean,
      definition: Schema.String,
    })
  ),
  constraints: Schema.Array(
    Schema.Struct({
      name: Name,
      kind: Schema.String,
      definition: Schema.String,
    })
  ),
  rowEstimate: Schema.NullOr(Count),
  sample: Schema.optionalKey(QueryResult),
}) {}

export class SchemaTree extends Schema.Class<SchemaTree>("SchemaTree")({
  schemas: Schema.Array(
    Schema.Struct({
      name: Name,
      tables: Schema.Array(TableSummary),
      views: Schema.Array(TableSummary),
      functions: Schema.Array(Schema.String),
    })
  ),
  /** Tables omitted after the schema read's 500-table cap. */
  truncatedTables: Count,
}) {}

export class QueryLogEntry extends Schema.Class<QueryLogEntry>("QueryLogEntry")({
  id: Name,
  checkout: Schema.String,
  source: Schema.Struct({ id: Name, name: Name }),
  sql: Schema.String,
  author: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("agent"), sessionId: SessionId, turn: TurnId }),
    Schema.Struct({ kind: Schema.Literal("user") }),
    Schema.Struct({
      kind: Schema.Literal("outside"),
      sessionId: SessionId,
      turn: TurnId,
      command: Schema.String,
    }),
  ]),
  tool: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(Count),
  elapsedMs: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
  at: Timestamp,
}) {}

export const DataErrorCode = Schema.Literals([
  "E-DATA-UNKNOWN-SOURCE",
  "E-DATA-UNREACHABLE",
  "E-DATA-DENIED",
  "E-DATA-READ-ONLY",
  "E-DATA-TIMEOUT",
  "E-DATA-SQL",
]);

export class DataError extends Schema.TaggedError<DataError>()("DataError", {
  code: DataErrorCode,
  message: Schema.String,
  fix: Schema.String,
}) {}

const Errors = Schema.Union([DataError, Unsupported, NotFound]);

const OnSession = { sessionId: SessionId };

/** `source` is the checkout's Data Source name, as returned by discovery. */
const OnSource = { ...OnSession, source: Name };

export const WatchDataSources = Rpc.make("data.sources.watch", {
  payload: OnSession,
  success: Schema.Array(DataSource),
  error: Errors,
  stream: true,
});

export const DescribeData = Rpc.make("data.describe", {
  payload: {
    ...OnSource,
    table: Schema.optionalKey(Name),
    sample: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  },
  success: Schema.Union([SchemaTree, TableDetail]),
  error: Errors,
});

export const QueryData = Rpc.make("data.query", {
  payload: {
    ...OnSource,
    sql: Name,
    params: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  },
  success: QueryResult,
  error: Errors,
});

export const WatchDataQueryLog = Rpc.make("data.queryLog.watch", {
  payload: OnSession,
  success: Schema.Array(QueryLogEntry),
  error: Errors,
  stream: true,
});

export const SaveDataSource = Rpc.make("data.source.save", {
  payload: {
    ...OnSession,
    name: Name,
    engine: DataEngine,
    host: Name,
    port: DataSource.fields.port,
    database: Name,
    user: Schema.String,
    password: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
    label: DataSourceLabel,
  },
  success: DataSource,
  error: Errors,
});

export const RemoveDataSource = Rpc.make("data.source.remove", {
  payload: OnSource,
  error: Errors,
});

export const LabelDataSource = Rpc.make("data.source.label", {
  payload: { ...OnSource, label: DataSourceLabel },
  success: DataSource,
  error: Errors,
});

export const DecideDataApproval = Rpc.make("data.approval.decide", {
  payload: {
    approvalId: RequestId,
    decision: Schema.Literals(["approve", "deny"]),
    scope: Schema.Literals(["target", "server"]),
    reason: Schema.optionalKey(Schema.String),
  },
  error: Errors,
});

export class DataRpcs extends RpcGroup.make(
  WatchDataSources,
  DescribeData,
  QueryData,
  WatchDataQueryLog,
  SaveDataSource,
  RemoveDataSource,
  LabelDataSource,
  DecideDataApproval
) {}
