/** Schema Diff snapshots and comparisons (ENG-645). */
import { Schema } from "effect";
import { SessionId, TurnId, Timestamp } from "./ids.ts";

export const SCHEMA_DIFF_CAPABILITY = "data.schemaDiff";

const Identity = Schema.Struct({ schema: Schema.String, name: Schema.String });

const Column = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  nullable: Schema.Boolean,
  default: Schema.NullOr(Schema.String),
  fingerprint: Schema.optionalKey(Schema.String),
  generated: Schema.optionalKey(Schema.String),
  collation: Schema.optionalKey(Schema.String),
  extra: Schema.optionalKey(Schema.String),
  pk: Schema.Boolean,
  fk: Schema.NullOr(
    Schema.Struct({ schema: Schema.String, table: Schema.String, column: Schema.String })
  ),
});

const Index = Schema.Struct({
  name: Schema.String,
  columns: Schema.Array(Schema.String),
  unique: Schema.Boolean,
  definition: Schema.String,
  fingerprint: Schema.optionalKey(Schema.String),
});

const Constraint = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  definition: Schema.String,
  fingerprint: Schema.optionalKey(Schema.String),
});

const change = <S extends Schema.Top>(value: S) =>
  Schema.Struct({
    name: Schema.String,
    before: Schema.NullOr(value),
    after: Schema.NullOr(value),
  });

export const SchemaTableDiff = Schema.Struct({
  kind: Schema.Literals(["added", "removed", "renamed", "changed"]),
  before: Schema.NullOr(Identity),
  after: Schema.NullOr(Identity),
  columns: Schema.Array(change(Column)),
  indexes: Schema.Array(change(Index)),
  constraints: Schema.Array(change(Constraint)),
  /** This table omitted details after 256; other table additions/removals remain exact. */
  detailsTruncated: Schema.optionalKey(Schema.Boolean),
  /**
   * Exact counts rows matched by writes through Polaris (agent + user), not the table's total change.
   * Observed outside commands/migrations/concurrent writers force estimate/unknown; unseen writers are excluded.
   */
  rows: Schema.Struct({
    kind: Schema.Literals(["exact", "estimate", "unknown"]),
    value: Schema.NullOr(Schema.Number),
    agent: Schema.optionalKey(Schema.Number),
    user: Schema.optionalKey(Schema.Number),
  }),
});

export type SchemaTableDiff = typeof SchemaTableDiff.Type;

export const SchemaSourceDiff = Schema.Struct({
  source: Schema.Struct({ id: Schema.String, name: Schema.String }),
  status: Schema.Literals(["complete", "pending", "unavailable"]),
  baseline: Schema.Literals(["turn-start", "first-use", "previous-turn-end"]),
  /** Capture followed Turn start or overlapped a later Turn; attribution may be incomplete. */
  capturedLate: Schema.optionalKey(Schema.Boolean),
  /** Turn that originally captured this baseline, including carried older content. */
  baselineTurn: Schema.optionalKey(TurnId),
  /** Original capture time for a carried baseline (display as “Since <time>”). */
  baselineCapturedAt: Schema.optionalKey(Timestamp),
  /** Another Agent Session used the same target during the capture window. */
  concurrent: Schema.optionalKey(Schema.Boolean),
  /** Real Data error code from capture, access denial or target/locality change. */
  errorCode: Schema.optionalKey(Schema.String),
  beforeAt: Schema.NullOr(Timestamp),
  afterAt: Schema.NullOr(Timestamp),
  /** A bounded catalog omitted tables; unmatched tables cannot establish additions/removals. */
  truncated: Schema.Boolean,
  tables: Schema.Array(SchemaTableDiff),
});

export type SchemaSourceDiff = typeof SchemaSourceDiff.Type;

export const DataSchemaDiff = Schema.Struct({
  sessionId: SessionId,
  turn: Schema.optionalKey(TurnId),
  /** Requested history was evicted by snapshot retention; an empty result is not “no changes”. */
  pruned: Schema.optionalKey(Schema.Boolean),
  sources: Schema.Array(SchemaSourceDiff),
});

export type DataSchemaDiff = typeof DataSchemaDiff.Type;
