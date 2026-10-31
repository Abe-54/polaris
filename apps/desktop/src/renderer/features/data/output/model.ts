/**
 * Output's Data tab for one Turn (DESIGN.md, Data → In Orchestrate): its writes, each with its
 * approval when this feed saw it, its schema changes, and its reads as a count. The tab is absent
 * when the Turn touched no data. Pure, so tested.
 */
import type {
  ApprovalRequest,
  DataSource,
  QueryLogEntry,
  SchemaSourceDiff,
  SessionId,
} from "@polaris/protocol";
import type { SettledWrite, WriteOutcome } from "../../../store/sessionModel.ts";
import { isWrite, tableOf } from "../model/queryLog.ts";
import type { TableRef } from "../model/tabs.ts";
import { type DataWrite, outcomeUnknown, settledLine, UNKNOWN_DETAIL } from "../write/model.ts";

export interface WriteApproval {
  readonly request: ApprovalRequest;
  readonly write: DataWrite;
  /** null while it still waits on the user. */
  readonly outcome: WriteOutcome | null;
}

export interface TurnWrite {
  readonly entry: QueryLogEntry;
  readonly approval: WriteApproval | null;
}

export interface TurnData {
  /** Oldest first, as the Turn ran them. */
  readonly writes: ReadonlyArray<TurnWrite>;
  readonly reads: ReadonlyArray<QueryLogEntry>;
  /** Sources whose schema changed in the Turn, or are still capturing. */
  readonly schema: ReadonlyArray<SchemaSourceDiff>;
}

export interface TurnDataInput {
  readonly entries: ReadonlyArray<QueryLogEntry>;
  readonly sessionId: SessionId;
  /** The Turns Output shows (a Turn and those its Harness started in it). */
  readonly turnIds: ReadonlySet<string>;
  readonly pending: ReadonlyArray<ApprovalRequest>;
  readonly settled: ReadonlyArray<SettledWrite>;
  readonly schema: ReadonlyArray<SchemaSourceDiff>;
}

const inTurn = (entry: QueryLogEntry, sessionId: SessionId, turnIds: ReadonlySet<string>) =>
  entry.author.kind !== "user" &&
  entry.author.sessionId === sessionId &&
  turnIds.has(entry.author.turn);

/** The dry run W logs beside a write: the write's card already says it. */
const isDryRun = (entry: QueryLogEntry) =>
  entry.state === "dry-run" || entry.id.endsWith(":dry-run");

const writes = (entry: QueryLogEntry) =>
  entry.approval !== undefined || entry.tool === "execute" || isWrite(entry.sql);

const approvalsOf = (input: TurnDataInput): ReadonlyArray<WriteApproval> => [
  ...input.pending.flatMap((request) =>
    request.dataWrite === undefined ? [] : [{ request, write: request.dataWrite, outcome: null }]
  ),
  ...input.settled.flatMap(({ request, outcome }) =>
    request.dataWrite === undefined ? [] : [{ request, write: request.dataWrite, outcome }]
  ),
];

/** The Turn's data activity, from the session's Query Log and approvals. */
export const turnData = (input: TurnDataInput): TurnData => {
  const own = input.entries
    .filter((e) => inTurn(e, input.sessionId, input.turnIds) && !isDryRun(e))
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const approvals = approvalsOf(input);

  return {
    writes: own.filter(writes).map((entry) => ({
      entry,
      approval:
        approvals.find(
          (a) => a.write.queryId === entry.id || a.request.id === entry.approval?.id
        ) ?? null,
    })),
    reads: own.filter((e) => !writes(e)),
    schema: input.schema.filter((s) => s.status !== "complete" || s.tables.length > 0),
  };
};

/** The tab shows only when the Turn touched data. */
export const hasData = (data: TurnData) =>
  data.writes.length > 0 || data.reads.length > 0 || data.schema.length > 0;

/** "12 reads", "1 read". */
export const readsLine = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "read" : "reads"}`;

export type WriteStatusKind =
  | "needs-you"
  | "running"
  | "done"
  | "failed"
  | "denied"
  | "cancelled"
  | "unknown";

export interface WriteStatus {
  readonly kind: WriteStatusKind;
  readonly line: string;
  readonly detail?: string;
}

const rows = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/** A write as the Query Log knows it alone, with no approval this feed saw. */
const entryStatus = (entry: QueryLogEntry): WriteStatus => {
  if (outcomeUnknown(entry))
    return { kind: "unknown", line: "Outcome unknown", detail: UNKNOWN_DETAIL };

  if (entry.state === "waiting-approval" || entry.approval?.status === "pending")
    return { kind: "needs-you", line: "Waiting for you" };

  switch (entry.state) {
    case "running":
      return { kind: "running", line: "Running…" };
    case "failed":
      return entry.approval?.status === "denied"
        ? { kind: "denied", line: entry.error ? `Denied: ${entry.error}` : "Denied" }
        : {
            kind: "failed",
            line: "Failed",
            detail: entry.error?.trim() || "The database refused the write.",
          };
    case "cancelled":
      return entry.approval?.status === "approved"
        ? { kind: "cancelled", line: "Allowed · not run yet" }
        : { kind: "cancelled", line: "Cancelled" };
    default:
      return { kind: "done", line: entry.rows === undefined ? "Ran" : `Ran · ${rows(entry.rows)}` };
  }
};

const SETTLED_KIND = {
  ran: "done",
  running: "running",
  allowed: "cancelled",
  failed: "failed",
  cancelled: "cancelled",
  denied: "denied",
  expired: "cancelled",
  unknown: "unknown",
} as const;

/** What a write card's status line says: its approval's ending when known, else the log's. */
export const writeStatus = ({ entry, approval }: TurnWrite): WriteStatus => {
  if (approval === null) return entryStatus(entry);

  if (approval.outcome === null) return { kind: "needs-you", line: "Waiting for you" };
  const settled = settledLine(approval.write, approval.outcome, entry);

  const status = { kind: SETTLED_KIND[settled.kind], line: settled.line };

  return settled.kind === "failed" || settled.kind === "unknown"
    ? { ...status, detail: settled.detail }
    : status;
};

/** "invoices · 214 rows" per table the write changed, as the Daemon counted them. */
export const affectedLines = (entry: QueryLogEntry): ReadonlyArray<string> =>
  (entry.affected ?? []).map(
    (a) => `${a.schema === undefined ? a.table : `${a.schema}.${a.table}`} · ${rows(a.rows)}`
  );

/** Where an unqualified table lives: Postgres' `public`, a MySQL database's own name. */
export const defaultSchema = (source: Pick<DataSource, "engine" | "database">) =>
  source.engine === "postgres" ? "public" : source.database;

/** The table "Open in Data" opens for a write: the first the Daemon counted, else the SQL's. */
export const writeTable = (entry: QueryLogEntry, schema: string): TableRef | null => {
  const first = entry.affected?.[0];

  if (first !== undefined) return { schema: first.schema ?? schema, name: first.table };
  const name = tableOf(entry.sql);

  return name === null ? null : { schema, name };
};
