/** Data Sources and Queries (ADR 0091, ENG-644). Credentials never appear in results. */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { Unsupported } from "./errors.ts";
import { RequestId, SessionId, Timestamp, TurnId } from "./ids.ts";

import {
  DataHost,
  DataValue,
  ScrubbedDataValue,
  ScrubbedText,
  dataJsonBytes,
  DATA_CHUNK_BYTES,
} from "./dataValues.ts";

export * from "./dataValues.ts";

export const DATA_CAPABILITY = "data";

const Name = Schema.String.check(Schema.isMinLength(1));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const DataColumn = Schema.Struct({ name: Schema.String, type: Schema.String });

const DataRow = Schema.Array(ScrubbedDataValue).check(Schema.isMaxLength(256));

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
  host: DataHost,
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
  error: Schema.optionalKey(ScrubbedText),
}) {}

export class QueryResult extends Schema.Class<QueryResult>("QueryResult")({
  queryId: Name,
  columns: Schema.Array(DataColumn).check(Schema.isMaxLength(256)),
  /** JSON wire values; database numerics retain their returned representation. */
  rows: Schema.Array(DataRow).check(
    Schema.isMaxLength(200),
    Schema.makeFilter((rows) => dataJsonBytes(rows) <= 4 * DATA_CHUNK_BYTES)
  ),
  /** Legacy alias of returned. */
  rowCount: Count,
  returned: Count,
  total: Schema.optionalKey(Count),
  truncated: Schema.Boolean,
  elapsedMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
}) {}

export class TableSummary extends Schema.Class<TableSummary>("TableSummary")({
  name: Name,
  rowEstimate: Schema.NullOr(Count),
  columnCount: Count,
  columns: Schema.Array(Schema.Struct({ name: Name, type: Schema.String })),
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
  loadedAt: Timestamp,
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
  sql: ScrubbedText,
  params: Schema.optionalKey(Schema.Array(ScrubbedDataValue)),
  state: Schema.Literals([
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "dry-run",
    "cancelled",
  ]),
  author: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("agent"), sessionId: SessionId, turn: TurnId }),
    Schema.Struct({ kind: Schema.Literal("user") }),
    Schema.Struct({
      kind: Schema.Literal("outside"),
      sessionId: SessionId,
      turn: TurnId,
      command: ScrubbedText,
    }),
  ]),
  approval: Schema.optionalKey(
    Schema.Struct({ id: RequestId, status: Schema.Literals(["pending", "approved", "denied"]) })
  ),
  tool: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(Count),
  elapsedMs: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(ScrubbedText),
  at: Timestamp,
}) {}

export const DataErrorCode = Schema.Literals([
  "E-DATA-UNKNOWN-SOURCE",
  "E-DATA-UNREACHABLE",
  "E-DATA-DENIED",
  "E-DATA-READ-ONLY",
  "E-DATA-TIMEOUT",
  "E-DATA-SQL",
  "E-DATA-CANCELLED",
]);

export class DataError extends Schema.TaggedError<DataError>()("DataError", {
  code: DataErrorCode,
  message: ScrubbedText,
  fix: ScrubbedText,
}) {}

const Errors = Schema.Union([DataError, Unsupported]);

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
    params: Schema.optionalKey(Schema.Array(DataValue)),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
  },
  success: QueryResult,
  error: Errors,
});

export const WatchDataQueryLog = Rpc.make("data.queryLog.watch", {
  payload: OnSession,
  success: Schema.Array(QueryLogEntry).check(Schema.isMaxLength(100)),
  error: Errors,
  stream: true,
});

export const SaveDataSource = Rpc.make("data.source.save", {
  payload: Schema.Struct({
    ...OnSession,
    name: Name,
    previousName: Schema.optionalKey(Name),
    passwordAction: Schema.optionalKey(Schema.Literals(["keep", "clear", "set"])),
    engine: DataEngine,
    host: DataHost,
    port: DataSource.fields.port,
    database: Name,
    user: Schema.String,
    password: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
    label: DataSourceLabel,
  }).check(
    Schema.makeFilter(
      ({ passwordAction, password }) =>
        passwordAction === undefined ||
        (passwordAction === "set" ? password !== undefined : password === undefined)
    )
  ),
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

/** The stream scope owns the read-only transaction; unsubscribe interrupts and rolls it back. */
export const QueryDataStreamItem = Schema.TaggedUnion({
  Header: { queryId: Name, columns: QueryResult.fields.columns },
  Rows: { rows: Schema.Array(DataRow).check(Schema.isMaxLength(500)) },
  End: {
    returned: Count,
    total: Schema.optionalKey(Count),
    truncated: Schema.Boolean,
    elapsedMs: QueryResult.fields.elapsedMs,
  },
}).check(Schema.makeFilter((item) => dataJsonBytes(item) <= DATA_CHUNK_BYTES));

export type QueryDataStreamItem = typeof QueryDataStreamItem.Type;

export const QueryDataStream = Rpc.make("data.query.stream", {
  payload: {
    ...QueryData.payloadSchema.fields,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))),
  },
  success: QueryDataStreamItem,
  error: Errors,
  stream: true,
});

/** Watches are snapshots of the latest 100 entries; pages are newest first, exclusive of before. */
export const DataQueryLogPage = Schema.Struct({
  entries: Schema.Array(QueryLogEntry).check(Schema.isMaxLength(100)),
  next: Schema.NullOr(Name),
});

export const PageDataQueryLog = Rpc.make("data.queryLog.page", {
  payload: {
    ...OnSession,
    before: Schema.optionalKey(Name),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  },
  success: DataQueryLogPage,
  error: Errors,
});

export const SetDataSourceAccess = Rpc.make("data.source.access", {
  payload: {
    ...OnSource,
    writes: Schema.optionalKey(DataSource.fields.writes),
    revoke: Schema.optionalKey(Schema.Boolean),
  },
  success: DataSource,
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
  QueryDataStream,
  PageDataQueryLog,
  SetDataSourceAccess
) {}
