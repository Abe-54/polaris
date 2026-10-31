/**
 * The Query Log drawer's rows (DESIGN.md, Data → Query Log; Paper D1): newest first, scoped to
 * the open table or source, each with its author, Turn, one-line SQL, rows and age. Pure.
 */
import type { HarnessKind, QueryLogEntry, SessionId, TurnId } from "@polaris/protocol";

/** What the drawer needs of an Agent Session; null when it isn't on this Host's list. */
export interface SessionFacts {
  readonly title: string;
  readonly harness: HarnessKind;
  readonly working: boolean;
  /** The user Turn in flight or last run: its id, 1-based number and start (ISO). */
  readonly turn: {
    readonly id: TurnId;
    readonly number: number;
    readonly startedAt: string;
  } | null;
}

export type SessionLookup = (id: SessionId) => SessionFacts | null;

export type Who =
  | { readonly kind: "you" }
  | {
      readonly kind: "agent" | "outside";
      readonly sessionId: SessionId;
      readonly title: string;
      readonly harness: HarnessKind | null;
      readonly turn: number | null;
    };

export type RowStatus = "needs-you" | "running" | "done" | "failed" | "dry-run" | "cancelled";

export interface LogRow {
  readonly entry: QueryLogEntry;
  readonly who: Who;
  readonly status: RowStatus;
  /** The SQL on one line; an outside row shows the command it ran. */
  readonly text: string;
}

export interface LogScope {
  readonly source: string;
  /** Only queries that name this table. */
  readonly table?: string | undefined;
}

export const oneLine = (sql: string) => sql.replaceAll(/\s+/g, " ").trim();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the SQL names the table as a word, bare, quoted or schema-qualified. */
export const mentionsTable = (sql: string, table: string) =>
  new RegExp(`(^|[^\\w$])["\`]?${escape(table)}["\`]?($|[^\\w$])`, "i").test(sql);

export const inScope = (entry: QueryLogEntry, scope: LogScope | null) =>
  scope === null ||
  (entry.source.name === scope.source &&
    (scope.table === undefined || mentionsTable(entry.sql, scope.table)));

const statusOf = (entry: QueryLogEntry): RowStatus => {
  if (entry.approval?.status === "pending" || entry.state === "waiting-approval")
    return "needs-you";

  if (entry.state === "completed") return entry.error === undefined ? "done" : "failed";

  return entry.state;
};

const whoOf = (entry: QueryLogEntry, lookup: SessionLookup): Who => {
  const { author } = entry;

  if (author.kind === "user") return { kind: "you" };
  const facts = lookup(author.sessionId);

  return {
    kind: author.kind,
    sessionId: author.sessionId,
    title: facts === null || facts.title === "" ? "An agent session" : facts.title,
    harness: facts?.harness ?? null,
    turn: facts?.turn?.id === author.turn ? facts.turn.number : null,
  };
};

export const logRows = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookup: SessionLookup,
  scope: LogScope | null
): ReadonlyArray<LogRow> =>
  entries
    .filter((entry) => inScope(entry, scope))
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .map((entry) => ({
      entry,
      who: whoOf(entry, lookup),
      status: statusOf(entry),
      text: oneLine(entry.author.kind === "outside" ? entry.author.command : entry.sql),
    }));

/** "Fix overdue totals · turn 12", "You", "Backfill currency · needs you", "… · outside Polaris". */
export const authorText = (row: LogRow): string => {
  const { who } = row;

  if (who.kind === "you") return "You";

  if (row.status === "needs-you") return `${who.title} · needs you`;

  if (who.kind === "outside") return `${who.title} · outside Polaris`;

  return who.turn === null ? who.title : `${who.title} · turn ${who.turn}`;
};

/** "214 rows", "1 row", "failed", "waiting", "running", "—". */
export const rowsText = (row: LogRow): string => {
  const { entry, status } = row;

  if (status === "failed") return "failed";

  if (status === "running") return "running";

  if (status === "cancelled") return "cancelled";

  if (entry.rows === undefined) return "—";

  return entry.rows === 1 ? "1 row" : `${entry.rows.toLocaleString("en-US")} rows`;
};

/** "now", "8m", "2h", "3d": a row's age, as the drawer prints it. */
export const ageText = (at: string, now: number): string => {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);

  if (minutes < 1) return "now";

  if (minutes < 60) return `${minutes}m`;

  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;

  return `${Math.floor(minutes / (24 * 60))}d`;
};

/** "Query log · invoices · 6", "Query log · app · 30". */
export const drawerKicker = (scope: LogScope | null, count: number) =>
  ["Query log", ...(scope === null ? [] : [scope.table ?? scope.source]), String(count)].join(
    " · "
  );

const READ = /^\s*(select|with|show|explain|describe|table|values)\b/i;

/** Words that change data or run code anywhere in a statement (`with … delete`, `explain analyze`). */
const CHANGES =
  /\b(insert|update|delete|merge|upsert|replace|drop|alter|truncate|create|grant|revoke|copy|call|do|exec|execute|into|lock|analyze|vacuum|set|load|handler|rename|comment|refresh|cluster|reindex|import|for\s+update|for\s+share)\b/i;

/** Only a lone read re-runs straight away; anything else opens in a SQL tab to run with ⌘↵. */
export const runsOnOpen = (sql: string) => {
  const text = sql.trim().replace(/;\s*$/, "");

  return READ.test(text) && !text.includes(";") && !CHANGES.test(text);
};
