/** Data Sources and Queries (ADR 0091, ENG-644). Credentials never appear in results. */
import { Schema } from "effect";
import { DataSchemaDiff } from "./schemaDiff.ts";
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

export const DATA_WRITE_CAPABILITY = "data.writes";

const Name = Schema.String.check(Schema.isMinLength(1));

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Indexes refer to the capped write grids; values remain scrubbed on both sides. */
export const DataWritePreviewFacts = {
  redactedCells: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        row: Count,
        column: Count,
        changed: Schema.Boolean,
      })
    )
  ),
  databaseFilledColumns: Schema.optionalKey(Schema.Array(Schema.String)),
  previewFacts: Schema.optionalKey(
    Schema.Struct({
      capped: Schema.Boolean,
      truncated: Schema.Boolean,
      readByKey: Schema.Boolean,
      sequences: Schema.Boolean,
    })
  ),
};

const DataColumn = Schema.Struct({ name: Schema.String, type: Schema.String });

const DataRow = Schema.Array(ScrubbedDataValue).check(Schema.isMaxLength(256));

export const DataEngine = Schema.Literals(["postgres", "mysql", "sqlite"]);

export type DataEngine = typeof DataEngine.Type;

/** The engines reached over the network, by host and port. */
export const ServerDataEngine = Schema.Literals(["postgres", "mysql"]);

export type ServerDataEngine = typeof ServerDataEngine.Type;

/** A database file on the Host (SQLite): absolute, one line, no NUL. */
export const DataFilePath = Schema.String.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((path) => path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)),
  Schema.makeFilter((path) => !/[\0\r\n]/.test(path))
);

/**
 * Placeholders a file source carries in the server fields: `localhost`, port 0, schema `main`.
 * Internal only: readers branch on `engine` and never show or connect with them for `sqlite`.
 */
export const DATA_FILE_SERVER = { host: "localhost", port: 0, database: "main" } as const;

export const DataSourceLabel = Schema.Struct({
  text: Schema.String,
  colour: Schema.Literals(["none", "grey", "green", "blue", "tan", "red"]),
});

export type DataSourceLabel = typeof DataSourceLabel.Type;

/** A server source's TLS mode, as libpq's `sslmode` names it; absent connects without TLS. */
export const DataTls = Schema.Literals([
  "disable",
  "allow",
  "prefer",
  "require",
  "verify-ca",
  "verify-full",
]);

export type DataTls = typeof DataTls.Type;

/** SAFETY for readers: for `sqlite`, host/port/database are `DATA_FILE_SERVER`; use `path`. */
const DataSourceFields = Schema.Struct({
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
  tls: Schema.optionalKey(DataTls),
  /** The database file on the Host: present exactly when `engine` is `sqlite`. */
  path: Schema.optionalKey(DataFilePath),
  foundIn: Schema.Struct({
    /** `daemon`: a Daemon Source, one of the Daemon's own databases (CONTEXT.md). */
    kind: Schema.Literals(["env", "framework", "compose", "manual", "daemon"]),
    file: Schema.optionalKey(Schema.String),
    key: Schema.optionalKey(Schema.String),
  }),
  access: Schema.Literals(["read", "needs-approval", "approved", "denied"]),
  writes: Schema.Literals(["ask", "off"]),
  label: DataSourceLabel,
  reachable: Schema.optionalKey(Schema.Boolean),
  privilegeWarnings: Schema.optionalKey(Schema.Array(ScrubbedText)),
  error: Schema.optionalKey(ScrubbedText),
}).check(
  Schema.makeFilter((source) => (source.engine === "sqlite") === (source.path !== undefined))
);

export class DataSource extends Schema.Class<DataSource>("DataSource")(DataSourceFields) {}

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

export class DataWriteResult extends Schema.Class<DataWriteResult>("DataWriteResult")({
  queryId: Name,
  affected: Count,
  elapsedMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  /** A grid commit's cells as the database stored them, read back in the same transaction. */
  written: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.Array(ScrubbedDataValue),
        column: Name,
        value: ScrubbedDataValue,
      })
    ).check(Schema.isMaxLength(10000))
  ),
}) {}

export const ExecuteDataInput = Schema.Struct({
  sessionId: SessionId,
  requestId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))
  ),
  source: Name,
  sql: Name.check(Schema.isMaxLength(32000)),
  params: Schema.optionalKey(Schema.Array(DataValue).check(Schema.isMaxLength(10000))),
  reason: Name.check(Schema.isMaxLength(4000)),
});

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
      fingerprint: Schema.optionalKey(Schema.String),
      generated: Schema.optionalKey(Schema.String),
      collation: Schema.optionalKey(Schema.String),
      extra: Schema.optionalKey(Schema.String),
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
      fingerprint: Schema.optionalKey(Schema.String),
    })
  ),
  constraints: Schema.Array(
    Schema.Struct({
      name: Name,
      kind: Schema.String,
      definition: Schema.String,
      fingerprint: Schema.optionalKey(Schema.String),
    })
  ),
  rowEstimate: Schema.NullOr(Count),
  sample: Schema.optionalKey(QueryResult),
  /** The primary key's columns in their declared order, which grid edits send keys in. */
  primaryKey: Schema.optionalKey(Schema.Array(Name)),
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
  /** Canonical target key, independent of checkout or source alias. */
  target: Schema.optionalKey(Schema.String),
  sql: ScrubbedText,
  params: Schema.optionalKey(Schema.Array(ScrubbedDataValue)),
  state: Schema.Literals([
    "running",
    "waiting-approval",
    "completed",
    "failed",
    "dry-run",
    "unknown",
    "cancelled",
    "expired",
  ]),
  author: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("agent"), sessionId: SessionId, turn: TurnId }),
    Schema.Struct({
      kind: Schema.Literal("user"),
      sessionId: Schema.optionalKey(SessionId),
      turn: Schema.optionalKey(TurnId),
    }),
    Schema.Struct({
      kind: Schema.Literal("outside"),
      sessionId: SessionId,
      turn: TurnId,
      command: ScrubbedText,
    }),
  ]),
  approval: Schema.optionalKey(
    Schema.Struct({
      id: RequestId,
      status: Schema.Literals(["pending", "approved", "denied", "expired"]),
      reason: Schema.optionalKey(ScrubbedText),
    })
  ),
  tool: Schema.optionalKey(Schema.String),
  rows: Schema.optionalKey(Count),
  affected: Schema.optionalKey(
    Schema.Array(Schema.Struct({ schema: Schema.optionalKey(Name), table: Name, rows: Count }))
  ),
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
  "E-DATA-OUTCOME-UNKNOWN",
  "E-DATA-CONFLICT",
]);

/** A grid edit the commit refused: the cell changed since it was staged, or its row is gone. */
export const DataEditConflict = Schema.TaggedUnion({
  Changed: {
    key: Schema.Array(ScrubbedDataValue),
    column: Name,
    value: ScrubbedDataValue,
  },
  Missing: { key: Schema.Array(ScrubbedDataValue) },
});

export type DataEditConflict = typeof DataEditConflict.Type;

export class DataError extends Schema.TaggedError<DataError>()("DataError", {
  code: DataErrorCode,
  message: ScrubbedText,
  fix: ScrubbedText,
  position: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  sqlLine: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  /** A grid commit's refused cells (`E-DATA-CONFLICT`). */
  conflicts: Schema.optionalKey(Schema.Array(DataEditConflict).check(Schema.isMaxLength(10000))),
  /** The key of the grid row whose update failed. */
  row: Schema.optionalKey(Schema.Array(ScrubbedDataValue)),
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
    engine: ServerDataEngine,
    host: DataHost,
    port: DataSource.fields.port,
    database: Name,
    user: Schema.String,
    password: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
    tls: Schema.optionalKey(DataTls),
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

/** A manual SQLite source: a file on the Host, with no server, user or password. */
export const SaveDataFileSource = Rpc.make("data.source.saveFile", {
  payload: {
    ...OnSession,
    name: Name,
    previousName: Schema.optionalKey(Name),
    path: DataFilePath,
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

export const CommitDataEdits = Rpc.make("data.edits.commit", {
  payload: {
    ...OnSource,
    table: Schema.Struct({ schema: Name, name: Name }),
    primaryKey: Schema.Array(Name).check(Schema.isMinLength(1)),
    edits: Schema.Array(
      Schema.Struct({
        key: Schema.Array(DataValue),
        column: Name,
        /** The value the user staged from: the commit refuses the cell if it has changed. */
        before: DataValue,
        value: DataValue,
      })
    ).check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
  },
  success: DataWriteResult,
  error: Errors,
});

export const GetDataSchemaDiff = Rpc.make("data.schemaDiff", {
  payload: {
    sessionId: SessionId,
    turn: Schema.optionalKey(TurnId),
    /**
     * A Turn group (`data.schemaDiff.turns`): `turn` and the Turns the Harness started after it,
     * compared from the first's before to the last's after.
     */
    turns: Schema.optionalKey(Schema.Array(TurnId).check(Schema.isMaxLength(1000))),
  },
  success: DataSchemaDiff,
  error: Errors,
});

export class DataRpcs extends RpcGroup.make(
  GetDataSchemaDiff,
  WatchDataSources,
  DescribeData,
  QueryData,
  WatchDataQueryLog,
  SaveDataSource,
  SaveDataFileSource,
  RemoveDataSource,
  LabelDataSource,
  QueryDataStream,
  PageDataQueryLog,
  SetDataSourceAccess,
  CommitDataEdits
) {}
