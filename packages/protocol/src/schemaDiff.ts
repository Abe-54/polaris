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
});

const Constraint = Schema.Struct({
  name: Schema.String,
  kind: Schema.String,
  definition: Schema.String,
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
  sources: Schema.Array(SchemaSourceDiff),
});

export type DataSchemaDiff = typeof DataSchemaDiff.Type;
