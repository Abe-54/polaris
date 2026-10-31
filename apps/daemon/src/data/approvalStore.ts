/** Per-Host decisions projected from durable approval events into data.sqlite. */
import { Database } from "bun:sqlite";
import { WriteApprovalStore } from "./writeApprovalStore.ts";
import {
  DataSourceApproval,
  type ApprovalRequest,
  type EventEnvelope,
  type DataSource,
} from "@polaris/protocol";
import { Match, Schema } from "effect";

export const targetOf = (source: DataSource) =>
  new DataSourceApproval({
    sourceId: source.id,
    sourceName: source.name,
    ...(source.branch === undefined ? undefined : { branch: source.branch }),
    engine: source.engine,
    host: source.host,
    port: source.port,
    database: source.database,
    user: source.user ?? "",
  });

export const serverKey = (target: DataSourceApproval) =>
  JSON.stringify([target.engine, target.host, target.port, target.user]);

export const targetKey = (target: DataSourceApproval) =>
  JSON.stringify([target.engine, target.host, target.port, target.database, target.user]);

interface SourcePolicy {
  access: DataSource["access"];
  writes: DataSource["writes"];
}

const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(DataSourceApproval));

export class ApprovalStore {
  readonly writes: WriteApprovalStore;
  constructor(readonly db: Database) {
    this.writes = new WriteApprovalStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS data_approval_cursor (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO data_approval_cursor VALUES (1,0);
      CREATE TABLE IF NOT EXISTS data_approval_requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS data_approval_waiters (request TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(request,session,turn));
      CREATE TABLE IF NOT EXISTS data_approval_rules (key TEXT PRIMARY KEY, access TEXT NOT NULL, writes TEXT NOT NULL DEFAULT 'off');`);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(data_approval_rules)").all();

    if (!columns.some((column) => column.name === "origin")) {
      db.exec("ALTER TABLE data_approval_rules ADD COLUMN origin TEXT NOT NULL DEFAULT 'decision'");
      db.exec(
        "UPDATE data_approval_rules SET origin='default' WHERE access='read' OR access='needs-approval'"
      );
      db.exec("DELETE FROM data_approval_rules WHERE json_array_length(key)=3");
    }

    if (!columns.some((column) => column.name === "write_locality"))
      db.exec("ALTER TABLE data_approval_rules ADD COLUMN write_locality TEXT");
  }
  get cursor() {
    return this.db
      .query<{ seq: number }, []>("SELECT seq FROM data_approval_cursor WHERE id=1")
      .get()!.seq;
  }
  apply(events: ReadonlyArray<EventEnvelope>, cut: number) {
    this.db.transaction(() => {
      for (const envelope of events) {
        this.writes.apply(envelope);
        const { event } = envelope;
        Match.value(event).pipe(
          Match.tag("ApprovalRequested", ({ request }) => this.opened(request)),
          Match.tag("ApprovalResolved", ({ requestId, decision }) => {
            const row = this.db
              .query<{ target: string }, [string]>(
                "SELECT target FROM data_approval_requests WHERE id=?"
              )
              .get(requestId);

            if (!row) return;
            const target = decodeTarget(row.target);
            Match.value(decision).pipe(
              Match.tag("Allow", (choice) => {
                this.db
                  .query("UPDATE data_approval_requests SET status='approved' WHERE id=?")
                  .run(requestId);

                if (choice.remember) {
                  this.set(
                    choice.dataScope === "server" ? serverKey(target) : targetKey(target),
                    "approved"
                  );
                }
              }),
              Match.tag("Deny", ({ reason }) => {
                this.db
                  .query("UPDATE data_approval_requests SET status='denied',reason=? WHERE id=?")
                  .run(reason, requestId);
                this.set(targetKey(target), "denied");
              }),
              Match.orElse(() => {})
            );
          }),
          Match.tag("ApprovalWithdrawn", ({ requestId, reason }) => {
            this.db
              .query(
                "UPDATE data_approval_requests SET status='denied',reason=? WHERE id=? AND status='pending'"
              )
              .run(reason, requestId);
          }),
          Match.orElse(() => {})
        );
      }

      this.db.query("UPDATE data_approval_cursor SET seq=? WHERE id=1").run(cut);
    })();
  }
  private opened(request: ApprovalRequest) {
    if (!request.dataSource) return;
    this.db
      .query("INSERT OR IGNORE INTO data_approval_requests VALUES (?,?,?,'pending',NULL)")
      .run(request.id, request.sessionId, JSON.stringify(request.dataSource));
  }
  private set(key: string, access: string) {
    this.db
      .query(
        "INSERT INTO data_approval_rules(key,access,origin) VALUES (?,?,'decision') ON CONFLICT(key) DO UPDATE SET access=excluded.access,origin='decision'"
      )
      .run(key, access);
  }
  read(source: DataSource): SourcePolicy {
    const target = targetOf(source);

    const query = this.db.query<
      {
        access: DataSource["access"];
        writes: DataSource["writes"];
        origin: string;
        write_locality: string | null;
      },
      [string]
    >("SELECT access,writes,origin,write_locality FROM data_approval_rules WHERE key=?");

    const exact = query.get(targetKey(target));
    const server = query.get(serverKey(target));
    const decision = exact?.origin === "decision" ? exact : server;
    const local = source.locality === "local";

    return {
      access: decision?.origin === "decision" ? decision.access : local ? "read" : "needs-approval",
      writes: exact?.write_locality === source.locality ? exact.writes : local ? "ask" : "off",
    };
  }
  change(source: DataSource, writes?: DataSource["writes"], revoke?: boolean) {
    const target = targetOf(source);
    const key = targetKey(target);
    this.db.transaction(() => {
      if (revoke) {
        this.db
          .query("DELETE FROM data_approval_rules WHERE key IN (?,?)")
          .run(key, serverKey(target));
        this.db
          .query(
            "UPDATE data_approval_requests SET status='denied',reason='Access revoked' WHERE json_extract(target,'$.engine')=? AND json_extract(target,'$.host')=? AND json_extract(target,'$.port')=? AND json_extract(target,'$.user')=?"
          )
          .run(target.engine, target.host, target.port, target.user);
      }

      if (writes !== undefined)
        this.db
          .query(
            "INSERT INTO data_approval_rules(key,access,writes,origin,write_locality) VALUES (?,'needs-approval',?,'default',?) ON CONFLICT(key) DO UPDATE SET writes=excluded.writes,write_locality=excluded.write_locality"
          )
          .run(key, writes, source.locality);
    })();
  }
  join(id: string, session: string, turn: string) {
    this.db
      .query("INSERT OR IGNORE INTO data_approval_waiters(request,session,turn) VALUES (?,?,?)")
      .run(id, session, turn);
  }
  consume(id: string, session: string, turn: string, source: DataSource) {
    return (
      this.db
        .query(`UPDATE data_approval_waiters SET used=1
      WHERE request=? AND session=? AND turn=? AND used=0 AND EXISTS (
        SELECT 1 FROM data_approval_requests WHERE id=? AND status='approved' AND json_array(json_extract(target,'$.engine'),json_extract(target,'$.host'),json_extract(target,'$.port'),json_extract(target,'$.database'),json_extract(target,'$.user'))=?)`)
        .run(id, session, turn, id, targetKey(targetOf(source))).changes === 1
    );
  }
  outcome(id: string) {
    return (
      this.writes.outcome(id) ??
      this.db
        .query<
          { status: "approved" | "denied" | "pending"; reason: string | null; session: string },
          [string]
        >("SELECT status,reason,session FROM data_approval_requests WHERE id=?")
        .get(id)
    );
  }
}
