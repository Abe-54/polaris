import type { Database } from "bun:sqlite";

const MAX_BYTES = 16 * 1024 * 1024;

const MAX_ENTRIES = 10000;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function initializeLogRetention(db: Database) {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(data_query_log)").all();

  if (!columns.some((column) => column.name === "logged_at")) {
    db.exec("ALTER TABLE data_query_log ADD COLUMN logged_at TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE data_query_log ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "UPDATE data_query_log SET logged_at=json_extract(value,'$.at'),bytes=length(CAST(value AS BLOB))"
    );
  }

  db.exec("CREATE INDEX IF NOT EXISTS data_query_age ON data_query_log(logged_at)");
}

/** One Host owns this database; checkout is a display filter, never a retention partition. */
export function pruneQueryLog(db: Database, now = Date.now()) {
  db.query("DELETE FROM data_query_log WHERE logged_at < ?").run(
    new Date(now - MAX_AGE_MS).toISOString()
  );

  const size = db
    .query<{ count: number; bytes: number }, []>(
      "SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM data_query_log"
    )
    .get()!;

  if (size.count <= MAX_ENTRIES && size.bytes <= MAX_BYTES) return;
  db.query(`DELETE FROM data_query_log WHERE seq IN (
    SELECT seq FROM (
      SELECT seq,row_number() OVER (ORDER BY seq DESC) AS rank,
      sum(bytes) OVER (ORDER BY seq DESC) AS bytes FROM data_query_log
    ) WHERE rank > ? OR bytes > ?)`).run(MAX_ENTRIES, MAX_BYTES);
}
