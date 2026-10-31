import { Schema } from "effect";
import { TraceTurn, WorkspaceId, SessionId, type LogRecord, type Span } from "@polaris/protocol";

export const TurnInterval = Schema.Struct({
  turn: TraceTurn,
  start: Schema.String,
  end: Schema.NullOr(Schema.String),
});

export const IngestContext = Schema.Struct({
  checkout: Schema.String,
  workspaceId: WorkspaceId,
  sessionId: Schema.NullOr(SessionId),
  turns: Schema.Array(TurnInterval),
  launchedTurn: Schema.optionalKey(Schema.NullOr(TraceTurn)),
});

export type IngestContext = typeof IngestContext.Type;

export interface TraceBatch {
  readonly spans: ReadonlyArray<Span>;
  readonly logs: ReadonlyArray<LogRecord>;
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const MAX_BATCH_RECORDS = 10_000;

/** Memory backpressure covers decoded/redacted batches as well as their smaller wire bodies. */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

export class IngestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface DecodedBatch extends TraceBatch {
  readonly bytes: number;
}

const serialized = new WeakMap<Span | LogRecord, { json: string; bytes: number }>();

/** Decoder admission, queue accounting and SQLite share exactly one serialization per record. */
export const serializeRecord = (record: Span | LogRecord) => {
  const existing = serialized.get(record);

  if (existing !== undefined) return existing;
  const json = JSON.stringify(record);
  const value = { json, bytes: Buffer.byteLength(json) };
  serialized.set(record, value);

  return value;
};
