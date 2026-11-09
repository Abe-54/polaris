/** The Send Log: one SQLite file for the Host, the newest 1,000 Sends of each checkout. */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RequestsError, Send, type SendLogPage, type SendLookup } from "@polaris/protocol";
import { Match, Schema } from "effect";

export const SEND_LOG_LIMIT = 1000;

export const SEND_LOG_PAGE = 100;

const encode = Schema.encodeSync(Schema.fromJsonString(Send));

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Send));

export const storageError = () =>
  new RequestsError({
    code: "E-REQUESTS-UNAVAILABLE",
    message: "Polaris couldn't read or save the Send Log on this host.",
    fix: "Check the host's storage and retry.",
  });

export const notFound = (what: string) =>
  new RequestsError({
    code: "E-SEND-NOT-FOUND",
    message: `No Send ${what} in this checkout's Send Log.`,
    fix: "Pick a Send from the Send Log; only the newest 1,000 are kept.",
  });

/** What `filter` matches: method, URL, status and author, lowercased. */
const searchText = (send: Send) =>
  [send.method, send.url, send.status ?? "", send.statusText ?? "", send.by.kind, send.outcome]
    .join(" ")
    .toLowerCase();

export interface PageOptions {
  readonly before?: string;
  readonly filter?: string;
  readonly limit?: number;
}

export class SendLogFile {
  private constructor(private readonly db: Database) {}

  static open(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    const db = new Database(filename, { create: true });

    if (filename !== ":memory:" && process.platform !== "win32") chmodSync(filename, 0o600);
    db.exec(`PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sends (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,checkout TEXT NOT NULL,
        trace_id TEXT,search TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sends_checkout ON sends(checkout,seq);
      CREATE INDEX IF NOT EXISTS sends_trace ON sends(checkout,trace_id);`);

    return new SendLogFile(db);
  }

  /** Adds a Send and drops the checkout's oldest beyond the limit, in one transaction. */
  put(send: Send) {
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO sends(id,checkout,trace_id,search,value) VALUES (?,?,?,?,?)")
        .run(send.id, send.checkout, send.traceId, searchText(send), encode(send));
      this.db
        .query(
          `DELETE FROM sends WHERE checkout=?1 AND seq<=(
            SELECT seq FROM sends WHERE checkout=?1 ORDER BY seq DESC LIMIT 1 OFFSET ?2)`
        )
        .run(send.checkout, SEND_LOG_LIMIT);
    })();
  }

  page(checkout: string, options: PageOptions = {}): SendLogPage {
    const limit = Math.min(options.limit ?? SEND_LOG_PAGE, SEND_LOG_PAGE);

    const cut =
      options.before === undefined
        ? Number.MAX_SAFE_INTEGER
        : (this.db
            .query<{ seq: number }, [string, string]>(
              "SELECT seq FROM sends WHERE checkout=? AND id=?"
            )
            .get(checkout, options.before)?.seq ?? 0);

    const rows = this.db
      .query<{ value: string }, [string, number, string, number]>(
        `SELECT value FROM sends WHERE checkout=? AND seq<? AND instr(search,?)>0
          ORDER BY seq DESC LIMIT ?`
      )
      .all(checkout, cut, (options.filter ?? "").trim().toLowerCase(), limit + 1);

    const sends = rows.slice(0, limit).map((row) => decode(row.value));

    return { sends, next: rows.length > limit ? sends.at(-1)!.id : null };
  }

  /** The newest Send matching the lookup, or undefined. */
  get(checkout: string, lookup: SendLookup): Send | undefined {
    const row = Match.valueTags(lookup, {
      ById: ({ id }) =>
        this.db
          .query<{ value: string }, [string, string]>(
            "SELECT value FROM sends WHERE checkout=? AND id=?"
          )
          .get(checkout, id),
      ByTrace: ({ traceId }) =>
        this.db
          .query<{ value: string }, [string, string]>(
            "SELECT value FROM sends WHERE checkout=? AND trace_id=? ORDER BY seq DESC LIMIT 1"
          )
          .get(checkout, traceId),
    });

    return row === null ? undefined : decode(row.value);
  }

  count(checkout: string) {
    return (
      this.db
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM sends WHERE checkout=?")
        .get(checkout)?.count ?? 0
    );
  }

  close() {
    this.db.close();
  }
}
