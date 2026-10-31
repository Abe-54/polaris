/**
 * The Query Log as rows (DESIGN.md, Data → Query Log) and what each agent is doing to data
 * ("Querying invoices", "Wants to write") for "Agents in this worktree".
 */
import type { QueryLogEntry, SessionId } from "@polaris/protocol";
import { maskLiterals } from "../sql/literals.ts";

/** The facts a row needs about an entry's Agent Session, from the Host's read model. */
export interface SessionFacts {
  readonly title: string;
  readonly harness: string;
  readonly needsYou: boolean;
  readonly working: boolean;
}

export type LogAuthor =
  | {
      readonly kind: "agent";
      readonly sessionId: SessionId;
      readonly title: string;
      /** null when the session isn't in this Host's read model. */
      readonly harness: string | null;
      readonly turn: number | null;
    }
  | { readonly kind: "user" }
  | {
      readonly kind: "outside";
      readonly title: string;
      readonly harness: string | null;
      readonly command: string;
    };

export type LogState = "done" | "failed" | "running" | "needs-you";

export interface LogRow {
  readonly id: string;
  readonly entry: QueryLogEntry;
  /** The SQL on one line. */
  readonly sql: string;
  readonly source: string;
  readonly author: LogAuthor;
  readonly state: LogState;
  /** "214 rows", "1 row", the error, or empty while it runs. */
  readonly result: string;
}

const WRITE = /^\s*(insert|update|delete|merge|upsert|replace|alter|create|drop|truncate)\b/i;

const TABLE =
  /\b(?:from|update|into|join|table)\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/i;

const CTE_WRITE = /^\s*with\b[\s\S]*\b(insert|update|delete|merge)\b/i;

/** Whether the statement changes rows or schema, by its keywords outside literals and comments. */
export const isWrite = (sql: string) => {
  const masked = maskLiterals(sql);

  return WRITE.test(masked) || CTE_WRITE.test(masked);
};

/** The first table a statement names, unquoted and without its schema; null for none. */
export const tableOf = (sql: string): string | null => {
  const name = TABLE.exec(sql)?.[1];

  if (name === undefined) return null;

  return (name.split(".").at(-1) ?? name).replace(/^["`]|["`]$/g, "");
};

const running = (entry: QueryLogEntry) => entry.state === "running";

/** A write waiting on the user: the Daemon holds it for a Data Source Approval. */
export const awaitsApproval = (entry: QueryLogEntry) =>
  entry.state === "waiting-approval" || entry.approval?.status === "pending";

const STATES: Record<QueryLogEntry["state"], LogState> = {
  running: "running",
  "waiting-approval": "needs-you",
  completed: "done",
  failed: "failed",
  "dry-run": "done",
  cancelled: "done",
};

const stateOf = (entry: QueryLogEntry): LogState =>
  awaitsApproval(entry) ? "needs-you" : STATES[entry.state];

const resultOf = (entry: QueryLogEntry, state: LogState) => {
  if (state === "failed") return entry.error ?? "";

  if (entry.state === "cancelled") return "cancelled";

  if (entry.state === "dry-run") return "dry run";

  if (entry.rows === undefined) return "";

  return `${entry.rows} ${entry.rows === 1 ? "row" : "rows"}`;
};

export interface LogLookups {
  readonly session: (id: SessionId) => SessionFacts | null;
  readonly turn: (id: SessionId, turn: string) => number | null;
}

const authorOf = (entry: QueryLogEntry, lookups: LogLookups): LogAuthor => {
  const { author } = entry;

  if (author.kind === "user") return { kind: "user" };
  const facts = lookups.session(author.sessionId);
  const title = facts?.title || "Untitled session";
  const harness = facts?.harness ?? null;

  if (author.kind === "outside")
    return { kind: "outside", title, harness, command: author.command };

  return {
    kind: "agent",
    sessionId: author.sessionId,
    title,
    harness,
    turn: lookups.turn(author.sessionId, author.turn),
  };
};

const sessionOf = (entry: QueryLogEntry) =>
  entry.author.kind === "user" ? null : entry.author.sessionId;

/** Newest first, with a write waiting on the user leading (it's the one that needs you). */
export const logRows = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookups: LogLookups
): ReadonlyArray<LogRow> => {
  const rows = entries.map((entry): LogRow => {
    const state = stateOf(entry);

    return {
      id: entry.id,
      entry,
      sql: entry.sql.replace(/\s+/g, " ").trim(),
      source: entry.source.name,
      author: authorOf(entry, lookups),
      state,
      result: resultOf(entry, state),
    };
  });

  const rank = (row: LogRow) => (row.state === "needs-you" ? 1 : 0);

  return rows.toSorted(
    (a, b) => rank(b) - rank(a) || Date.parse(b.entry.at) - Date.parse(a.entry.at)
  );
};

/**
 * What an agent is doing to data, for its row in "Agents in this worktree": a write waiting on
 * you, else the table of its running or (while it works) latest Query; null for nothing.
 */
export const dataActivity = (
  sessionId: SessionId,
  entries: ReadonlyArray<QueryLogEntry>,
  facts: SessionFacts
): string | null => {
  const own = entries.filter((e) => sessionOf(e) === sessionId);

  if (own.some(awaitsApproval)) return "Wants to write";
  const latest = own.findLast(running) ?? (facts.working ? own.at(-1) : undefined);

  if (latest === undefined) return null;
  const table = tableOf(latest.sql);

  return table === null ? "Querying data" : `Querying ${table}`;
};

export const busyKey = (source: string, table: string) => `${source}\u0000${table}`;

/** Tables an agent's running read is on, to the Harness reading them (the tree's dither). */
export const busyTables = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookups: LogLookups
): ReadonlyMap<string, string> => {
  const busy = new Map<string, string>();

  for (const entry of entries) {
    if (entry.author.kind !== "agent" || !running(entry) || isWrite(entry.sql)) continue;
    const facts = lookups.session(entry.author.sessionId);
    const table = tableOf(entry.sql);

    if (facts?.working === true && table !== null)
      busy.set(busyKey(entry.source.name, table), facts.harness);
  }

  return busy;
};

/** What the drawer under the grid shows: one Data Source, and one table while a table tab is open. */
export interface LogScope {
  readonly source: string;
  readonly table?: string | undefined;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether the SQL names the table as a word, bare, quoted or schema-qualified. */
export const mentionsTable = (sql: string, table: string) =>
  new RegExp(`(^|[^\\w$])["\`]?${escape(table)}["\`]?($|[^\\w$])`, "i").test(maskLiterals(sql));

export const inScope = (entry: QueryLogEntry, scope: LogScope | null) =>
  scope === null ||
  (entry.source.name === scope.source &&
    (scope.table === undefined || mentionsTable(entry.sql, scope.table)));

/** The drawer's rows: `logRows` within its scope. */
export const scopedRows = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookups: LogLookups,
  scope: LogScope | null
): ReadonlyArray<LogRow> => logRows(entries, lookups).filter((row) => inScope(row.entry, scope));

/** "Fix overdue totals · turn 12", "You", "Backfill currency · needs you", "… · outside Polaris". */
export const authorText = (row: LogRow): string => {
  const { author } = row;

  if (author.kind === "user") return "You";

  if (row.state === "needs-you") return `${author.title} · needs you`;

  if (author.kind === "outside") return `${author.title} · outside Polaris`;

  return author.turn === null ? author.title : `${author.title} · turn ${author.turn}`;
};

/** The drawer's rows column: "214 rows", "failed" (the error is the row's tooltip), or "—". */
export const resultText = (row: LogRow): string => {
  if (row.state === "failed") return "failed";

  if (row.state === "running") return "running";

  return row.result === "" ? "—" : row.result;
};

/** "Query log · invoices · 6", "Query log · app · 30". */
export const drawerKicker = (scope: LogScope | null, count: number) =>
  ["Query log", ...(scope === null ? [] : [scope.table ?? scope.source]), String(count)].join(
    " · "
  );

/** What makes a SELECT write or lock: `select … into`, `for update`, `for share`. */
const CHANGES = /\b(into|for\s+(update|share|no\s+key\s+update|key\s+share))\b/i;

/** Words that may stand before `(` without calling anything: `in (…)`, `from (select …)`. */
const NOT_CALLS = new Set(
  "in exists any all some not and or on using from join where select as values lateral by having when then else case".split(
    " "
  )
);

/** Whether the statement calls a function: `pg_sleep(…)`, `count(*)`, `"f"(…)`. */
const callsFunction = (masked: string) =>
  [...masked.matchAll(/([\w$]+|"[^"]+"|`[^`]+`)\s*\(/g)].some(
    ([, name]) => name !== undefined && !NOT_CALLS.has(name.toLowerCase())
  );

/**
 * Only a lone plain SELECT that calls no function re-runs straight away; anything else (a
 * function may act, as `pg_terminate_backend` does) opens in a SQL tab to run with ⌘↵.
 */
export const runsOnOpen = (sql: string) => {
  const text = maskLiterals(sql).trim().replace(/;\s*$/, "");

  return (
    /^select\b/i.test(text) && !text.includes(";") && !CHANGES.test(text) && !callsFunction(text)
  );
};

const DDL = /^\s*(create|alter|drop|truncate|rename|comment)\b/i;

/** The newest finished schema change on the source, by id: the SQL tab re-reads its schema. */
export const schemaChange = (
  entries: ReadonlyArray<QueryLogEntry>,
  source: string
): string | null => {
  let newest: QueryLogEntry | null = null;

  for (const entry of entries)
    if (
      entry.source.name === source &&
      entry.state === "completed" &&
      DDL.test(maskLiterals(entry.sql)) &&
      (newest === null || entry.at >= newest.at)
    )
      newest = entry;

  return newest?.id ?? null;
};
