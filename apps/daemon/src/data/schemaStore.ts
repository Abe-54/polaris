/** Per-session, per-Turn catalogs in data.sqlite; never in the event log. */
import type { Database } from "bun:sqlite";
import { SessionId, TurnId, TableDetail, type SchemaSourceDiff } from "@polaris/protocol";
import { Schema } from "effect";
import { compareCatalogs, type AffectedTable } from "./schemaCompare.ts";

export const Snapshot = Schema.Struct({
  at: Schema.String,
  tables: Schema.Array(TableDetail),
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
  baseline: Schema.Literals(["turn-start", "first-use", "previous-turn-end"]),
  before: Schema.NullOr(Snapshot),
  after: Schema.NullOr(Snapshot),
  used: Schema.Boolean,
  failed: Schema.Boolean,
});

export type SnapshotRecord = typeof Record.Type;

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Record));

export class SchemaStore {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS data_schema_snapshots (
      session TEXT NOT NULL, turn TEXT NOT NULL, source TEXT NOT NULL, value TEXT NOT NULL,
      PRIMARY KEY(session,turn,source));
      CREATE INDEX IF NOT EXISTS data_schema_session ON data_schema_snapshots(session);`);
  }
  put(record: SnapshotRecord) {
    this.db
      .query(
        "INSERT INTO data_schema_snapshots VALUES (?,?,?,?) ON CONFLICT(session,turn,source) DO UPDATE SET value=excluded.value"
      )
      .run(record.sessionId, record.turn, record.source.id, JSON.stringify(record));
  }
  records(sessionId: string, turn?: string) {
    return this.db
      .query<{ value: string }, [string]>("SELECT value FROM data_schema_snapshots WHERE session=?")
      .all(sessionId)
      .map((x) => decode(x.value))
      .filter((x) => turn === undefined || x.turn === turn)
      .sort((a, b) => a.index - b.index);
  }
  remove(sessionId: string) {
    this.db.query("DELETE FROM data_schema_snapshots WHERE session=?").run(sessionId);
  }
  previous(sessionId: string, source: string, index: number) {
    return this.records(sessionId)
      .filter((x) => x.source.id === source && x.index < index && x.after !== null)
      .at(-1);
  }
  // Unknown commands and un-attributed Client writes conservatively make a baseline stale.
  stale(record: SnapshotRecord) {
    if (!record.after) return true;

    return (
      this.db
        .query<{ n: number }, [string, string, string]>(`SELECT count(*) n FROM data_query_activity
      WHERE checkout=? AND updated>=? AND session<>?`)
        .get(record.checkout, record.after.at, record.sessionId)!.n > 0
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
            ? compareCatalogs(first.before, last.after, affected)
            : [],
      };
    });

    return { sessionId, ...(turn === undefined ? undefined : { turn }), sources };
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
