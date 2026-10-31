/** SQLite stays in the trace worker, separate from the event log. No idle polling or vacuum timer. */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Option, Schema } from "effect";
import { Span, TraceSummary } from "@polaris/protocol";
import { serializeRecord, type TraceBatch } from "./ingest.ts";

export interface Retention {
  readonly maxBytes: number;
  readonly maxAgeMs: number;
}

export const DEFAULT_RETENTION: Retention = {
  maxBytes: 200 * 1024 * 1024,
  maxAgeMs: 7 * 86400_000,
};

export const openTraceDatabase = (filename: string): Database => {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename, { create: true });

  if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=DELETE;
    PRAGMA auto_vacuum=INCREMENTAL;
    PRAGMA busy_timeout=1000;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS spans (
      checkout TEXT NOT NULL,trace_id TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,
      start TEXT NOT NULL,end TEXT NOT NULL,service TEXT NOT NULL,status TEXT NOT NULL,
      age INTEGER NOT NULL,bytes INTEGER NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(checkout,trace_id,id));
    CREATE INDEX IF NOT EXISTS spans_age ON spans(checkout,status,age);
    CREATE INDEX IF NOT EXISTS spans_retention ON spans(checkout,age,bytes);
    CREATE TABLE IF NOT EXISTS logs (
      checkout TEXT NOT NULL,id TEXT NOT NULL,trace_id TEXT,span_id TEXT,
      time TEXT NOT NULL,severity INTEGER NOT NULL,age INTEGER NOT NULL,bytes INTEGER NOT NULL,value TEXT NOT NULL,
      PRIMARY KEY(checkout,id));
    CREATE INDEX IF NOT EXISTS logs_span ON logs(checkout,trace_id,span_id,time);
    CREATE INDEX IF NOT EXISTS logs_age ON logs(checkout,age);
    CREATE INDEX IF NOT EXISTS logs_retention ON logs(checkout,age,bytes);
    CREATE TABLE IF NOT EXISTS trace_pins (
      checkout TEXT NOT NULL,trace_id TEXT NOT NULL,PRIMARY KEY(checkout,trace_id));
    CREATE TABLE IF NOT EXISTS summaries (
      checkout TEXT NOT NULL,trace_id TEXT NOT NULL,start TEXT NOT NULL,root TEXT NOT NULL,
      duration REAL NOT NULL,errors INTEGER NOT NULL,turn_id TEXT,partial INTEGER NOT NULL DEFAULT 0,value TEXT NOT NULL,
      PRIMARY KEY(checkout,trace_id));
    CREATE INDEX IF NOT EXISTS summaries_start ON summaries(checkout,start DESC,trace_id);
  `);

  migrateHistory(db);

  return db;
};

const migrateHistory = (db: Database) => {
  const columns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))(
    db.query("PRAGMA table_info(spans)").all()
  );

  db.transaction(() => {
    if (!columns.some((column) => column.name === "name")) {
      db.exec(`ALTER TABLE spans ADD COLUMN name TEXT;
        ALTER TABLE spans ADD COLUMN parent_name TEXT;
        ALTER TABLE spans ADD COLUMN trace_start TEXT;
        ALTER TABLE spans ADD COLUMN duration REAL;
        UPDATE spans SET name=json_extract(value,'$.name'),duration=json_extract(value,'$.durationMs');
        UPDATE spans AS c SET parent_name=(SELECT p.name FROM spans p
          WHERE p.checkout=c.checkout AND p.trace_id=c.trace_id AND p.id=c.parent),
          trace_start=(SELECT s.start FROM summaries s WHERE s.checkout=c.checkout AND s.trace_id=c.trace_id);`);
    }

    db.exec(`CREATE INDEX IF NOT EXISTS spans_history_covering ON spans(checkout,name,parent_name,trace_start DESC,start DESC,duration);
      DROP INDEX IF EXISTS spans_history;
      CREATE INDEX IF NOT EXISTS summaries_history ON summaries(checkout,root,start DESC);
      CREATE INDEX IF NOT EXISTS spans_error ON spans(checkout,trace_id,status,start);`);
  })();
};

export const ValueRow = Schema.Struct({ value: Schema.String });

export const decodeValueRow = Schema.decodeUnknownSync(ValueRow);

export const decodeValueRows = Schema.decodeUnknownSync(Schema.Array(ValueRow));

const decodeSpan = Schema.decodeUnknownSync(Schema.fromJsonString(Span));

const decodeStats = Schema.decodeUnknownSync(
  Schema.Struct({
    start: Schema.String,
    end: Schema.String,
    count: Schema.Number,
    errors: Schema.Number,
  })
);

const decodeServices = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ service: Schema.String }))
);

const decodePartial = Schema.decodeUnknownOption(Schema.Struct({ partial: Schema.Number }));

/** Padded decimal uint64s sort exactly in SQLite without signed-64 overflow or float rounding. */
export const sortableTime = (ns: string): string => ns.padStart(20, "0");

export const refreshSummary = (
  db: Database,
  checkout: string,
  traceId: string,
  partial = false
): void => {
  const row = db
    .query(
      "SELECT value FROM spans WHERE checkout=? AND trace_id=? ORDER BY parent IS NOT NULL,start,id LIMIT 1"
    )
    .get(checkout, traceId);

  if (row === null) {
    db.query("DELETE FROM summaries WHERE checkout=? AND trace_id=?").run(checkout, traceId);

    return;
  }

  const root = decodeSpan(decodeValueRow(row).value);

  const stats = decodeStats(
    db
      .query(
        "SELECT min(start) AS start,max(end) AS end,count(*) AS count,sum(status='error') AS errors FROM spans WHERE checkout=? AND trace_id=?"
      )
      .get(checkout, traceId)
  );

  db.query(`UPDATE spans AS c SET
    parent_name=(SELECT p.name FROM spans p WHERE p.checkout=c.checkout AND p.trace_id=c.trace_id AND p.id=c.parent),
    trace_start=? WHERE c.checkout=? AND c.trace_id=? AND (c.trace_start IS NOT ? OR
    c.parent_name IS NOT (SELECT p.name FROM spans p WHERE p.checkout=c.checkout AND p.trace_id=c.trace_id AND p.id=c.parent))`).run(
    stats.start,
    checkout,
    traceId,
    stats.start
  );

  const services = decodeServices(
    db
      .query("SELECT DISTINCT service FROM spans WHERE checkout=? AND trace_id=? ORDER BY service")
      .all(checkout, traceId)
  ).map((s) => s.service);

  const old = decodePartial(
    db.query("SELECT partial FROM summaries WHERE checkout=? AND trace_id=?").get(checkout, traceId)
  );

  const wasPartial = Option.isSome(old) && old.value.partial === 1;
  const start = BigInt(stats.start);

  const summary = TraceSummary.make({
    id: traceId,
    root: root.name,
    rootSpanId: root.id,
    service: root.service,
    startedAt: new Date(Number(start / 1000000n)).toISOString(),
    startTimeUnixNano: start.toString(),
    durationMs: Number(BigInt(stats.end) - start) / 1e6,
    spans: stats.count,
    services,
    errors: stats.errors,
    status: stats.errors > 0 ? "error" : root.status,
    turn: root.polaris.turn,
    sessionId: root.polaris.sessionId,
    linked:
      db
        .query("SELECT 1 FROM trace_pins WHERE checkout=? AND trace_id=?")
        .get(checkout, traceId) !== null,
    partial: partial || wasPartial,
  });

  db.query(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(checkout,trace_id) DO UPDATE SET start=excluded.start,root=excluded.root,duration=excluded.duration,
    errors=excluded.errors,turn_id=excluded.turn_id,partial=excluded.partial,value=excluded.value`).run(
    checkout,
    traceId,
    stats.start,
    summary.root,
    summary.durationMs,
    summary.errors,
    summary.turn?.id ?? null,
    Number(summary.partial),
    JSON.stringify(summary)
  );
};

/** The caller owns the transaction and invokes retention before committing it. */
export const writeBatch = (db: Database, batch: TraceBatch): Map<string, Set<string>> => {
  const changed = new Map<string, Set<string>>();

  const mark = (checkout: string, traceId: string | null) => {
    let ids = changed.get(checkout);

    if (ids === undefined) {
      ids = new Set();
      changed.set(checkout, ids);
    }

    if (traceId !== null) ids.add(traceId);
  };

  const spanInsert =
    db.query(`INSERT INTO spans (checkout,trace_id,id,parent,start,end,service,status,age,bytes,value,name,duration) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(checkout,trace_id,id) DO UPDATE SET parent=excluded.parent,start=excluded.start,end=excluded.end,
    service=excluded.service,status=excluded.status,age=excluded.age,bytes=excluded.bytes,value=excluded.value,name=excluded.name,duration=excluded.duration`);

  const logInsert = db.query("INSERT INTO logs VALUES (?,?,?,?,?,?,?,?,?)");

  for (const span of batch.spans) {
    const { json: value, bytes } = serializeRecord(span);
    spanInsert.run(
      span.polaris.checkout,
      span.traceId,
      span.id,
      span.parentId,
      sortableTime(span.startTimeUnixNano),
      sortableTime(span.endTimeUnixNano),
      span.service,
      span.status,
      Number(BigInt(span.startTimeUnixNano) / 1000000n),
      bytes + 256,
      value,
      span.name,
      span.durationMs
    );
    mark(span.polaris.checkout, span.traceId);
  }

  for (const log of batch.logs) {
    const { json: value, bytes } = serializeRecord(log);
    logInsert.run(
      log.polaris.checkout,
      log.id,
      log.traceId,
      log.spanId,
      sortableTime(log.timeUnixNano),
      log.severityNumber,
      Number(
        BigInt(log.timeUnixNano === "0" ? log.observedTimeUnixNano : log.timeUnixNano) / 1000000n
      ),
      bytes + 128,
      value
    );
    mark(log.polaris.checkout, log.traceId);
  }

  return changed;
};
