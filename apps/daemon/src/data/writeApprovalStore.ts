/** Write approval consumption is durable and one-shot, including after a Daemon restart. */
import type { Database } from "bun:sqlite";
import {
  ApprovalRequest,
  DataWriteResult,
  type DataError,
  type EventEnvelope,
} from "@polaris/protocol";
import { Match, Schema } from "effect";

export class WriteApprovalStore {
  constructor(readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS data_write_requests (
      id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,request TEXT NOT NULL,
      status TEXT NOT NULL,reason TEXT,result TEXT);`);
    db.exec("UPDATE data_write_requests SET status='unknown' WHERE status='started'");
  }
  apply({ event }: EventEnvelope) {
    Match.value(event).pipe(
      Match.tag("ApprovalRequested", ({ request }) => {
        if (!request.dataWrite) return;
        this.db
          .query("INSERT OR IGNORE INTO data_write_requests VALUES (?,?,?,'pending',NULL,NULL)")
          .run(request.id, request.dataWrite.fingerprint, JSON.stringify(request));
      }),
      Match.tag("ApprovalResolved", ({ requestId, decision }) => {
        Match.value(decision).pipe(
          Match.tag("Allow", () =>
            this.db
              .query(
                "UPDATE data_write_requests SET status='approved' WHERE id=? AND status='pending'"
              )
              .run(requestId)
          ),
          Match.tag("Deny", ({ reason }) =>
            this.db
              .query(
                "UPDATE data_write_requests SET status='denied',reason=? WHERE id=? AND status='pending'"
              )
              .run(reason, requestId)
          ),
          Match.orElse(() => {})
        );
      }),
      Match.tag("ApprovalWithdrawn", ({ requestId, reason }) =>
        this.db
          .query(
            "UPDATE data_write_requests SET status='denied',reason=? WHERE id=? AND status='pending'"
          )
          .run(reason, requestId)
      ),
      Match.orElse(() => {})
    );
  }
  find(fingerprint: string) {
    const row = this.db
      .query<
        { request: string; status: string; reason: string | null; result: string | null },
        [string]
      >("SELECT request,status,reason,result FROM data_write_requests WHERE fingerprint=?")
      .get(fingerprint);

    return row
      ? {
          request: Schema.decodeUnknownSync(Schema.fromJsonString(ApprovalRequest))(row.request),
          status: row.status,
          reason: row.reason,
          result:
            row.result === null
              ? null
              : Schema.decodeUnknownSync(Schema.fromJsonString(DataWriteResult))(row.result),
        }
      : undefined;
  }
  outcome(id: string) {
    const row = this.db
      .query<{ status: string; reason: string | null }, [string]>(
        "SELECT status,reason FROM data_write_requests WHERE id=?"
      )
      .get(id);

    if (!row) return undefined;

    return {
      status: Match.value(row.status).pipe(
        Match.when("pending", () => "pending" as const),
        Match.when("denied", () => "denied" as const),
        Match.orElse(() => "approved" as const)
      ),
      reason: row.reason || (row.status === "denied" ? "The user denied this write." : null),
    };
  }
  claim(id: string) {
    return (
      this.db
        .query("UPDATE data_write_requests SET status='started' WHERE id=? AND status='approved'")
        .run(id).changes === 1
    );
  }
  fail(id: string, error: DataError) {
    this.db
      .query("UPDATE data_write_requests SET status=?,reason=? WHERE id=? AND status='started'")
      .run(error.code === "E-DATA-OUTCOME-UNKNOWN" ? "unknown" : "failed", error.message, id);
  }
  finish(id: string, result: DataWriteResult) {
    this.db
      .query(
        "UPDATE data_write_requests SET status='completed',result=? WHERE id=? AND status='started'"
      )
      .run(JSON.stringify(result), id);
  }
}
