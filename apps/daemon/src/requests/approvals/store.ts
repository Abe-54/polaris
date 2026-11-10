/** Per-Host Origin Approvals projected from durable approval events, keyed by origin. */
import type { Database } from "bun:sqlite";
import type { ApprovalRequest, EventEnvelope, OriginScope } from "@polaris/protocol";
import { Match } from "effect";

export type OriginOutcome =
  | { readonly status: "approved" }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "pending" };

export interface OriginRule {
  readonly origin: string;
  readonly scope: OriginScope;
}

export const READS_ONLY = "The user allowed reads only at this origin; this Send writes.";

/** Whether `scope` lets a Send through: writes need `reads-and-writes`. */
export const scopeAllows = (scope: OriginScope | undefined, write: boolean) =>
  scope === "reads-and-writes" || (scope === "reads" && !write);

interface RequestRow {
  readonly session: string;
  readonly origin: string;
  readonly status: "pending" | "approved" | "denied";
  readonly scope: OriginScope | null;
  readonly reason: string | null;
}

export class OriginApprovalStore {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS origin_approval_cursor (id INTEGER PRIMARY KEY, seq INTEGER NOT NULL);
      INSERT OR IGNORE INTO origin_approval_cursor VALUES (1,0);
      CREATE TABLE IF NOT EXISTS origin_approval_requests (id TEXT PRIMARY KEY, session TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, scope TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS origin_approval_waiters (request TEXT NOT NULL, session TEXT NOT NULL, turn TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(request,session,turn));
      CREATE TABLE IF NOT EXISTS origin_approval_rules (origin TEXT PRIMARY KEY, scope TEXT NOT NULL);`);
  }

  get cursor() {
    return this.db
      .query<{ seq: number }, []>("SELECT seq FROM origin_approval_cursor WHERE id=1")
      .get()!.seq;
  }

  apply(events: ReadonlyArray<EventEnvelope>, cut: number) {
    this.db.transaction(() => {
      for (const { event } of events)
        Match.value(event).pipe(
          Match.tag("ApprovalRequested", ({ request }) => this.opened(request)),
          Match.tag("ApprovalResolved", ({ requestId, decision }) =>
            Match.value(decision).pipe(
              Match.tag("Allow", ({ remember, originScope }) =>
                this.allowed(requestId, originScope ?? "reads", remember)
              ),
              Match.tag("Deny", ({ reason }) =>
                this.denied(requestId, reason ?? "The user denied this origin.")
              ),
              Match.orElse(() => {})
            )
          ),
          Match.tag("ApprovalWithdrawn", ({ requestId, reason }) => this.denied(requestId, reason)),
          Match.orElse(() => {})
        );

      this.db.query("UPDATE origin_approval_cursor SET seq=? WHERE id=1").run(cut);
    })();
  }

  private opened(request: ApprovalRequest) {
    if (!request.origin) return;
    this.db
      .query("INSERT OR IGNORE INTO origin_approval_requests VALUES (?,?,?,'pending',NULL,NULL)")
      .run(request.id, request.sessionId, request.origin.origin);
  }

  private allowed(id: string, scope: OriginScope, remember: boolean) {
    const row = this.db
      .query<{ origin: string }, [string, string]>(
        "UPDATE origin_approval_requests SET status='approved',scope=? WHERE id=? AND status='pending' RETURNING origin"
      )
      .get(scope, id);

    if (row && remember)
      this.db
        .query(
          "INSERT INTO origin_approval_rules VALUES (?,?) ON CONFLICT(origin) DO UPDATE SET scope=excluded.scope"
        )
        .run(row.origin, scope);
  }

  private denied(id: string, reason: string) {
    this.db
      .query(
        "UPDATE origin_approval_requests SET status='denied',reason=? WHERE id=? AND status='pending'"
      )
      .run(reason, id);
  }

  /** The remembered scope for `origin`, if any. */
  rule(origin: string): OriginScope | undefined {
    return (
      this.db
        .query<{ scope: OriginScope }, [string]>(
          "SELECT scope FROM origin_approval_rules WHERE origin=?"
        )
        .get(origin)?.scope ?? undefined
    );
  }

  rules(): OriginRule[] {
    return this.db
      .query<OriginRule, []>("SELECT origin,scope FROM origin_approval_rules ORDER BY origin")
      .all();
  }

  /** Forgets the remembered scope and voids grants not yet used. */
  revoke(origin: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM origin_approval_rules WHERE origin=?").run(origin);
      this.db
        .query(
          "UPDATE origin_approval_requests SET status='denied',reason='Access revoked' WHERE origin=? AND status!='denied'"
        )
        .run(origin);
    })();
  }

  join(id: string, session: string, turn: string) {
    this.db
      .query("INSERT OR IGNORE INTO origin_approval_waiters(request,session,turn) VALUES (?,?,?)")
      .run(id, session, turn);
  }

  /** Spends a one-Send grant: the card's own Agent Session, the waiter's Turn, the same origin and a scope that allows it. */
  consume(id: string, session: string, turn: string, origin: string, write: boolean) {
    const row = this.row(id);

    if (row?.status !== "approved" || row.session !== session || row.origin !== origin)
      return false;

    if (!scopeAllows(row.scope ?? undefined, write)) return false;

    return (
      this.db
        .query(
          "UPDATE origin_approval_waiters SET used=1 WHERE request=? AND session=? AND turn=? AND used=0"
        )
        .run(id, session, turn).changes === 1
    );
  }

  /** The answer for one Send: a reads-only approval denies a write. */
  outcome(id: string, write: boolean): OriginOutcome {
    const row = this.row(id);

    if (!row) return { status: "denied", reason: "This origin approval no longer exists." };

    if (row.status === "denied")
      return { status: "denied", reason: row.reason ?? "The user denied this origin." };

    if (row.status === "pending") return { status: "pending" };

    return scopeAllows(row.scope ?? undefined, write)
      ? { status: "approved" }
      : { status: "denied", reason: READS_ONLY };
  }

  private row(id: string) {
    return this.db
      .query<RequestRow, [string]>(
        "SELECT session,origin,status,scope,reason FROM origin_approval_requests WHERE id=?"
      )
      .get(id);
  }
}
