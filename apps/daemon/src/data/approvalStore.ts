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
  JSON.stringify([target.engine, target.host, target.port]);

export const targetKey = (target: DataSourceApproval) =>
  JSON.stringify([target.engine, target.host, target.port, target.database, target.user]);

const decodeTarget = Schema.decodeUnknownSync(Schema.fromJsonString(DataSourceApproval));

export class ApprovalStore {
  readonly writes: WriteApprovalStore;
  constructor(readonly db: Database) {
    this.writes = new WriteApprovalStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS data_approval_cursor (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO data_approval_cursor VALUES (1,0);
      CREATE TABLE IF NOT EXISTS data_approval_requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS data_approval_rules (key TEXT PRIMARY KEY, access TEXT NOT NULL, writes TEXT NOT NULL DEFAULT 'off');`);
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
                this.set(targetKey(target), "approved");

                if (choice.dataScope === "server") this.set(serverKey(target), "approved");
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
        "INSERT INTO data_approval_rules(key,access) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET access=excluded.access"
      )
      .run(key, access);
  }
  read(source: DataSource): { access: DataSource["access"]; writes: DataSource["writes"] } {
    const target = targetOf(source);

    const query = this.db.query<
      { access: DataSource["access"]; writes: DataSource["writes"] },
      [string]
    >("SELECT access,writes FROM data_approval_rules WHERE key=?");

    const exact = query.get(targetKey(target));
    const server = query.get(serverKey(target));

    return (
      exact ??
      server ?? {
        access: source.locality === "local" ? "read" : "needs-approval",
        writes: source.locality === "local" ? "ask" : "off",
      }
    );
  }
  change(source: DataSource, writes?: DataSource["writes"], revoke?: boolean) {
    const key = targetKey(targetOf(source));
    const current = this.read(source);
    this.db
      .query(
        "INSERT INTO data_approval_rules VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET access=excluded.access,writes=excluded.writes"
      )
      .run(key, revoke ? "needs-approval" : current.access, writes ?? current.writes);
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
