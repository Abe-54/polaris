/**
 * Agents' writes waiting on the user (Paper D3), for previews, screenshots and tests: Backfill
 * currency's 214-row update on app, and the worst cases (256 columns, huge cells, NULLs, bytes).
 */
import {
  type ApprovalRequest,
  type DataValue,
  DataValueTags,
  QueryLogEntry,
  RequestId,
  type SessionId,
  TurnId,
} from "@polaris/protocol";
import type { DataWrite } from "../write/model.ts";
import { FIXTURE_NOW, FIXTURE_SESSIONS } from "./fixtures.ts";

const CHECKOUT = "/Users/lucas/code/ledger.worktrees/overdue-totals";

/** app, the Local Data Source the fixtures' Data mode lists. */
export const APP_TARGET: DataWrite["target"] = {
  sourceId: "src-app",
  sourceName: "app",
  engine: "postgres",
  host: "localhost",
  port: 5432,
  database: "ledger_overdue",
  user: "ledger",
};

/** ledger, the PlanetScale branch: Remote, tan. */
export const BRANCH_TARGET: DataWrite["target"] = {
  sourceId: "src-ledger-branch",
  sourceName: "ledger",
  engine: "mysql",
  host: "aws.connect.psdb.cloud",
  port: 3306,
  database: "ledger",
  user: "overdue-totals-agent",
  branch: { provider: "planetscale", name: "overdue-totals" },
};

const INVOICE_COLUMNS = ["id", "customer_id", "status", "currency", "total_minor", "due_at"];

const invoice = (n: number, currency: string | null): ReadonlyArray<DataValue> => [
  `inv_${String(4810 + n).padStart(5, "0")}`,
  `c-${100 + (n % 17)}`,
  "overdue",
  currency,
  12_000 + n * 375,
  DataValueTags.cases.Timestamp.make({
    iso: `2026-09-${String(1 + (n % 28)).padStart(2, "0")}T00:00:00.000Z`,
  }),
];

/** The update the conversation's card shows: 20 of 214 rows, the currency NULL → USD. */
export const fixtureWrite = (change: Partial<DataWrite> = {}): DataWrite => ({
  target: APP_TARGET,
  fingerprint: "fp-backfill",
  queryId: "q-backfill-write",
  sql: "update invoices\n   set currency = 'USD'\n where currency is null\n   and created_at < '2026-01-01'",
  reason:
    "214 invoices from before the currency column have no currency. They were all billed in USD, so the overdue totals skip them.",
  affected: 214,
  columns: INVOICE_COLUMNS,
  before: Array.from({ length: 20 }, (_, n) => invoice(n, null)),
  after: Array.from({ length: 20 }, (_, n) => invoice(n, "USD")),
  note: "",
  previewFacts: { capped: true, truncated: false, readByKey: true, sequences: false },
  ...change,
});

let opened = 0;

/** A write approval as W's event carries it, in Backfill currency's Turn 5. */
export const fixtureWriteApproval = (
  write: DataWrite = fixtureWrite(),
  change: { readonly id?: string; readonly sessionId?: SessionId; readonly turnId?: string } = {}
): ApprovalRequest => ({
  id: RequestId.make(change.id ?? `r-write-${++opened}`),
  sessionId: change.sessionId ?? FIXTURE_SESSIONS.backfill.id,
  turnId: TurnId.make(change.turnId ?? "turn-5"),
  kind: "tool",
  dataWrite: write,
  title: `Run ${write.affected}-row write`,
  detail: `Dry run · rolled back · ${write.affected} rows\n${write.sql}\n${write.reason}`,
  options: [],
  questions: [],
  placeholder: null,
  expiresAt: null,
  openedAt: new Date(FIXTURE_NOW - 30_000).toISOString(),
});

/** The statement's bound params, as the Daemon sends them (scrubbed). */
export const withParams = (write: DataWrite, params: ReadonlyArray<DataValue>): DataWrite => ({
  ...write,
  params,
});

/** A write the Daemon ran no dry run for: the note says why, in the Daemon's words. */
export const notPreviewedWrite = (
  note = "Not previewed: this table has triggers",
  sql = "update payments set settled = true where invoice_id = $1"
): DataWrite =>
  fixtureWrite({
    sql,
    affected: 0,
    columns: [],
    before: [],
    after: [],
    note,
    previewed: false,
    params: ["inv_04810"],
  });

/** An insert: no before, three new rows, their serial `id` filled by the database. */
export const insertWrite = (): DataWrite =>
  fixtureWrite({
    sql: "insert into currencies (code, minor_units, name) values ('CHF', 2, 'Swiss franc'), ('JPY', 0, 'Yen'), ('KWD', 3, 'Kuwaiti dinar')",
    affected: 3,
    columns: ["id", "code", "minor_units", "name"],
    before: [],
    after: [
      [41, "CHF", 2, "Swiss franc"],
      [42, "JPY", 0, "Yen"],
      [43, "KWD", 3, "Kuwaiti dinar"],
    ],
    databaseFilledColumns: ["id"],
    previewFacts: { capped: false, truncated: false, readByKey: false, sequences: true },
  });

/** A password reset: the credential column redacted on both sides, marked changed. */
export const credentialWrite = (): DataWrite =>
  fixtureWrite({
    queryId: "q-password",
    sql: "update users set password_hash = $1, updated_at = now() where id = $2",
    reason: "Reset the support account's password after the leak, as the incident runbook says.",
    affected: 1,
    columns: ["id", "email", "password_hash", "updated_at"],
    before: [[42, "support@ledger.dev", "[redacted]", "2026-08-01 09:30:00+00"]],
    after: [[42, "support@ledger.dev", "[redacted]", "2026-10-31 01:12:00+00"]],
    params: ["[redacted]", 42],
    redactedCells: [{ row: 0, column: 2, changed: true }],
    previewFacts: { capped: false, truncated: false, readByKey: true, sequences: false },
  });

const HUGE = "x".repeat(4000);

/** The worst case: 256 columns, a huge cell, NULLs, bytes, long SQL, a long reason. */
export const worstWrite = (): DataWrite => {
  const columns = Array.from({ length: 256 }, (_, i) =>
    i === 7
      ? "a_column_name_that_goes_on_and_on_past_any_reasonable_width_for_a_header"
      : `col_${i}`
  );

  const row = (n: number, after: boolean): ReadonlyArray<DataValue> =>
    columns.map((_, i): DataValue => {
      if (i === 0) return n;

      if (i === 3) return after ? "settled" : null;

      if (i === 4) return DataValueTags.cases.Bytes.make({ length: 2048, preview: "\\x89504e47…" });

      if (i === 5) return after ? `${HUGE}${n}` : HUGE;

      if (i === 6)
        return DataValueTags.cases.Truncated.make({ preview: '{"payload":', bytes: 18_000_000 });

      return i % 5 === 0 ? null : `v${n}-${i}`;
    });

  return fixtureWrite({
    target: BRANCH_TARGET,
    sql: Array.from(
      { length: 40 },
      (_, i) =>
        `${i === 0 ? "update ledger_entries set" : "   ,"} col_${i + 1} = coalesce(col_${i + 1}, 'a much longer default value than anyone expects ${i}')`
    )
      .concat(["where account_id in (select id from accounts where region = 'emea')"])
      .join("\n"),
    reason: `${"The ledger entries need their defaults back after the import. ".repeat(12)}`,
    affected: 1_204_118,
    columns,
    before: Array.from({ length: 20 }, (_, n) => row(n, false)),
    after: Array.from({ length: 20 }, (_, n) => row(n, true)),
    previewFacts: { capped: true, truncated: true, readByKey: false, sequences: false },
  });
};

const at = (seconds: number) => new Date(FIXTURE_NOW - seconds * 1000).toISOString();

/** A write's main Query Log entry in a given state, as W logs it under the approval's query id. */
export const fixtureWriteEntry = (
  write: DataWrite,
  state: QueryLogEntry["state"],
  change: Partial<ConstructorParameters<typeof QueryLogEntry>[0]> = {}
): QueryLogEntry =>
  new QueryLogEntry({
    id: write.queryId,
    checkout: CHECKOUT,
    source: { id: write.target.sourceId, name: write.target.sourceName },
    sql: write.sql,
    state,
    author: { kind: "agent", sessionId: FIXTURE_SESSIONS.backfill.id, turn: TurnId.make("turn-5") },
    tool: "execute",
    at: at(10),
    ...change,
  });
