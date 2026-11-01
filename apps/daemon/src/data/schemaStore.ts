/** Per-session, per-Turn catalogs in data.sqlite; never in the event log. */
import type { Database } from "bun:sqlite";
import {
  SessionId,
  TurnId,
  TableDetail,
  DataErrorCode,
  type SchemaSourceDiff,
} from "@polaris/protocol";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { fingerprint, scrubCatalogText } from "./schemaScrub.ts";
import { compareCatalogs, type AffectedTable } from "./schemaCompare.ts";

export const Snapshot = Schema.Struct({
  at: Schema.String,
  tables: Schema.Array(
    Schema.Struct({
      ...TableDetail.fields,
      identity: Schema.optionalKey(Schema.String),
      detailsTruncated: Schema.optionalKey(Schema.Boolean),
    })
  ),
  truncated: Schema.Boolean,
});

const Affected = Schema.Struct({
  schema: Schema.optionalKey(Schema.String),
  table: Schema.String,
  rows: Schema.Number,
  author: Schema.Literals(["agent", "user"]),
});

const Record = Schema.Struct({
  affected: Schema.optionalKey(Schema.Array(Affected)),
  sessionId: SessionId,
  turn: TurnId,
  index: Schema.Number,
  checkout: Schema.String,
  source: Schema.Struct({ id: Schema.String, name: Schema.String }),
  target: Schema.String,
  startedAt: Schema.optionalKey(Schema.String),
  baseline: Schema.Literals(["turn-start", "first-use", "previous-turn-end"]),
  before: Schema.NullOr(Snapshot),
  after: Schema.NullOr(Snapshot),
  used: Schema.Boolean,
  failed: Schema.Boolean,
  errorCode: Schema.optionalKey(DataErrorCode),
  baselineTurn: Schema.optionalKey(TurnId),
  afterTurn: Schema.optionalKey(TurnId),
  endCaptured: Schema.optionalKey(Schema.Boolean),
  capturedLate: Schema.optionalKey(Schema.Boolean),
  concurrent: Schema.optionalKey(Schema.Boolean),
  uncertain: Schema.optionalKey(Schema.Boolean),
});

export type SnapshotRecord = typeof Record.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Record));

const Reference = Schema.NullOr(Schema.Struct({ hash: Schema.String, at: Schema.String }));

const Stored = Schema.Struct({ ...Record.fields, before: Reference, after: Reference });

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Stored));

const Payload = Schema.Struct({
  tables: Snapshot.fields.tables,
  truncated: Snapshot.fields.truncated,
});

const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));

export class SchemaStore {
  private readonly references = new WeakMap<object, string>();
  constructor(
    readonly db: Database,
    readonly byteCap = 64 * 1024 * 1024
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS data_schema_snapshots (
      session TEXT NOT NULL, turn TEXT NOT NULL, source TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(session,turn,source));
      CREATE INDEX IF NOT EXISTS data_schema_session ON data_schema_snapshots(session);
      CREATE INDEX IF NOT EXISTS data_schema_previous ON data_schema_snapshots(session,source,json_extract(value,'$.index'));
      CREATE TABLE IF NOT EXISTS data_schema_catalogs (hash TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS data_schema_pruned (session TEXT NOT NULL,turn TEXT NOT NULL,PRIMARY KEY(session,turn));
      CREATE TABLE IF NOT EXISTS data_target_activity (target TEXT NOT NULL,session TEXT NOT NULL,kind TEXT NOT NULL,updated TEXT NOT NULL,turn TEXT,PRIMARY KEY(target,session,kind));`);

    // Convert legacy inline catalogs once; subsequent reads only hydrate the requested Turn.
    const legacy = db.query<{ value: string }, []>(
      "SELECT value FROM data_schema_snapshots WHERE json_type(value,'$.before.tables')='array' OR json_type(value,'$.after.tables')='array' LIMIT 1"
    );

    let row = legacy.get();

    while (row) {
      this.put(decode(row.value));
      row = legacy.get();
    }
  }
  private reference(snapshot: typeof Snapshot.Type | null) {
    if (!snapshot) return null;
    const existing = this.references.get(snapshot);

    if (existing && this.db.query("SELECT 1 FROM data_schema_catalogs WHERE hash=?").get(existing))
      return { hash: existing, at: snapshot.at };

    const tables = snapshot.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        default: column.default === null ? null : "[redacted]",
        ...(column.default === null && column.generated === undefined && column.extra === undefined
          ? undefined
          : {
              fingerprint:
                column.fingerprint ??
                fingerprint(JSON.stringify([column.default, column.generated, column.extra])),
            }),
        ...(column.generated === undefined
          ? undefined
          : { generated: scrubCatalogText(column.generated) }),
        ...(column.extra === undefined ? undefined : { extra: scrubCatalogText(column.extra) }),
      })),
      indexes: table.indexes.map((index) => ({
        ...index,
        columns: index.columns.map(scrubCatalogText),
        definition: scrubCatalogText(index.definition),
        fingerprint: index.fingerprint ?? fingerprint(index.definition),
      })),
      constraints: table.constraints.map((constraint) => ({
        ...constraint,
        definition: scrubCatalogText(constraint.definition),
        fingerprint: constraint.fingerprint ?? fingerprint(constraint.definition),
      })),
    }));

    const value = JSON.stringify({ tables, truncated: snapshot.truncated });
    const hash = createHash("sha256").update(value).digest("hex");
    this.db.query("INSERT OR IGNORE INTO data_schema_catalogs VALUES (?,?)").run(hash, value);
    this.references.set(snapshot, hash);

    return { hash, at: snapshot.at };
  }
  private hydrate(value: string, cache = new Map<string, typeof Payload.Type>()): SnapshotRecord {
    const row = decodeStored(value);

    const read = (ref: typeof Reference.Type) => {
      if (!ref) return null;
      let content = cache.get(ref.hash);

      if (!content) {
        const payload = this.db
          .query<{ value: string }, [string]>("SELECT value FROM data_schema_catalogs WHERE hash=?")
          .get(ref.hash);

        if (!payload) throw new Error("Missing Schema Diff catalog");
        content = decodePayload(payload.value);
        cache.set(ref.hash, content);
      }

      const snapshot = { ...content, at: ref.at };
      this.references.set(snapshot, ref.hash);

      return snapshot;
    };

    return { ...row, before: read(row.before), after: read(row.after) };
  }
  put(record: SnapshotRecord) {
    this.db.transaction(() => {
      // A delayed capture cannot resurrect a Turn that retention already evicted.
      if (
        this.db
          .query("SELECT 1 FROM data_schema_pruned WHERE session=? AND turn=?")
          .get(record.sessionId, record.turn)
      )
        return;

      const value = JSON.stringify({
        ...record,
        before: this.reference(record.before),
        after: this.reference(record.after),
      });

      this.db
        .query(
          "INSERT INTO data_schema_snapshots VALUES (?,?,?,?) ON CONFLICT(session,turn,source) DO UPDATE SET value=excluded.value"
        )
        .run(record.sessionId, record.turn, record.source.id, value);
      this.prune(record.sessionId);
    })();
  }
  private prune(session: string) {
    const old = this.db
      .query<
        { turn: string },
        [string]
      >(`SELECT turn FROM data_schema_snapshots WHERE session=? GROUP BY turn
      ORDER BY max(json_extract(value,'$.index')) DESC LIMIT -1 OFFSET 50`)
      .all(session);

    for (const row of old) this.evict(session, row.turn);
    this.collect();

    while (this.bytes() > this.byteCap) {
      const oldest = this.db
        .query<{ session: string; turn: string }, []>(
          "SELECT session,turn FROM data_schema_snapshots ORDER BY rowid LIMIT 1"
        )
        .get();

      if (!oldest) break;
      this.evict(oldest.session, oldest.turn);
      this.collect();
    }
  }
  bytes() {
    return this.db
      .query<
        { n: number },
        []
      >(`SELECT (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM data_schema_catalogs) +
      (SELECT coalesce(sum(length(CAST(value AS BLOB))),0) FROM data_schema_snapshots) n`)
      .get()!.n;
  }
  private evict(session: string, turn: string) {
    this.db.query("INSERT OR IGNORE INTO data_schema_pruned VALUES (?,?)").run(session, turn);
    this.db
      .query("DELETE FROM data_schema_snapshots WHERE session=? AND turn=?")
      .run(session, turn);
  }
  private collect() {
    this.db.exec(`DELETE FROM data_schema_catalogs WHERE hash NOT IN (
      SELECT json_extract(value,'$.before.hash') FROM data_schema_snapshots WHERE json_extract(value,'$.before.hash') IS NOT NULL
      UNION SELECT json_extract(value,'$.after.hash') FROM data_schema_snapshots WHERE json_extract(value,'$.after.hash') IS NOT NULL)`);
  }
  records(sessionId: string, turn?: string) {
    const rows =
      turn === undefined
        ? this.db
            .query<{ value: string }, [string]>(
              "SELECT value FROM data_schema_snapshots WHERE session=? ORDER BY json_extract(value,'$.index')"
            )
            .all(sessionId)
        : this.db
            .query<{ value: string }, [string, string]>(
              "SELECT value FROM data_schema_snapshots WHERE session=? AND turn=?"
            )
            .all(sessionId, turn);

    const cache = new Map<string, typeof Payload.Type>();

    return rows.map((x) => this.hydrate(x.value, cache));
  }
  remove(sessionId: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM data_schema_snapshots WHERE session=?").run(sessionId);
      this.db.query("DELETE FROM data_schema_pruned WHERE session=?").run(sessionId);
      this.collect();
    })();
  }
  previous(sessionId: string, source: string, index: number) {
    const row = this.db
      .query<{ value: string }, [string, string, number]>(`SELECT value FROM data_schema_snapshots
      WHERE session=? AND source=? AND json_extract(value,'$.index')=? AND json_extract(value,'$.after.hash') IS NOT NULL LIMIT 1`)
      .get(sessionId, source, index - 1);

    return row ? this.hydrate(row.value) : undefined;
  }
  stale(record: SnapshotRecord) {
    if (!record.after) return true;

    return (
      this.db
        .query<{ n: number }, [string, string]>(
          "SELECT count(*) n FROM data_target_activity WHERE target=? AND updated>=?"
        )
        .get(record.target, record.after.at)!.n > 0
    );
  }
  activity(target: string, session: string, turn: string) {
    this.db
      .query(
        "INSERT INTO data_target_activity VALUES (?,?,'outside',?,?) ON CONFLICT(target,session,kind) DO UPDATE SET updated=excluded.updated,turn=excluded.turn"
      )
      .run(target, session, new Date().toISOString(), turn);
  }
  concurrent(record: SnapshotRecord, until: string) {
    return (
      this.db
        .query<
          { n: number },
          [string, string, string, string]
        >(`SELECT count(*) n FROM data_target_activity
      WHERE target=? AND session<>? AND updated>=? AND updated<=?`)
        .get(
          record.target,
          record.sessionId,
          record.startedAt ?? record.before?.at ?? until,
          until
        )!.n > 0
    );
  }
  entries(sessionId: string, turn?: string) {
    return this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM data_query_log WHERE json_extract(value,'$.author.sessionId')=? ORDER BY seq"
      )
      .all(sessionId)
      .map((x) => Schema.decodeUnknownSync(Schema.fromJsonString(LogEntry))(x.value))
      .filter((x) => turn === undefined || x.author.turn === turn);
  }
  affected(sessionId: string, turn: string, source: string) {
    return affectedRows(this.entries(sessionId, turn), source);
  }
  diff(sessionId: SessionId, turn?: TurnId) {
    const records = this.records(sessionId, turn).filter((x) => x.used);
    const groups = new Map<string, SnapshotRecord[]>();

    for (const r of records) groups.set(r.source.id, [...(groups.get(r.source.id) ?? []), r]);
    const entries = this.entries(sessionId, turn);

    const sources: SchemaSourceDiff[] = [...groups.values()].map((group) => {
      const first = group[0]!;
      const last = group.at(-1)!;

      const affected = group.flatMap(
        (row) =>
          row.affected ??
          affectedRows(
            entries.filter((x) => x.author.turn === row.turn),
            row.source.id
          )
      );

      const sameTarget = group.every((x) => x.target === first.target);

      return {
        source: first.source,
        baseline: first.baseline,
        ...(first.baselineTurn
          ? {
              baselineTurn: first.baselineTurn,
              ...(first.before ? { baselineCapturedAt: first.before.at } : undefined),
            }
          : undefined),
        ...(first.capturedLate ? { capturedLate: true } : undefined),
        ...(group.some((x) => x.concurrent) ? { concurrent: true } : undefined),
        ...(group.find((x) => x.errorCode)?.errorCode
          ? { errorCode: group.find((x) => x.errorCode)!.errorCode }
          : undefined),
        status:
          !sameTarget || group.some((x) => x.failed)
            ? "unavailable"
            : first.before && last.after
              ? "complete"
              : "pending",
        beforeAt: first.before?.at ?? null,
        afterAt: last.after?.at ?? null,
        truncated: group.some((x) => x.before?.truncated || x.after?.truncated),
        tables:
          sameTarget && first.before && last.after
            ? compareCatalogs(
                first.before,
                last.after,
                affected,
                group.some((x) => x.uncertain || x.concurrent)
              )
            : [],
      };
    });

    const pruned =
      turn === undefined
        ? this.db.query("SELECT 1 FROM data_schema_pruned WHERE session=? LIMIT 1").get(sessionId)
        : this.db
            .query("SELECT 1 FROM data_schema_pruned WHERE session=? AND turn=?")
            .get(sessionId, turn);

    return {
      sessionId,
      ...(turn === undefined ? undefined : { turn }),
      ...(pruned ? { pruned: true } : undefined),
      sources,
    };
  }
}

// Read only attribution and counts; the optional W field is valid before its producer lands.
const LogEntry = Schema.Struct({
  source: Schema.Struct({ id: Schema.String, name: Schema.String }),
  state: Schema.String,
  tool: Schema.optionalKey(Schema.String),
  author: Schema.Struct({
    kind: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
    turn: Schema.optionalKey(Schema.String),
  }),
  affected: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        schema: Schema.optionalKey(Schema.String),
        table: Schema.String,
        rows: Schema.Number,
      })
    )
  ),
});

const affectedRows = (
  entries: ReadonlyArray<typeof LogEntry.Type>,
  source: string
): AffectedTable[] =>
  entries
    .filter(
      (x) =>
        x.source.id === source &&
        x.state === "completed" &&
        (x.author.kind === "agent" || (x.author.kind === "user" && x.tool === "data.edits.commit"))
    )
    .flatMap((x) =>
      (x.affected ?? []).map((a) => ({
        ...a,
        author: x.author.kind === "agent" ? ("agent" as const) : ("user" as const),
      }))
    );
