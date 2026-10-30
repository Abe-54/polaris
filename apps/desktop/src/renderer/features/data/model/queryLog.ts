/**
 * The Query Log as rows (DESIGN.md, Data → Query Log) and what each agent is doing to data
 * ("Querying invoices", "Wants to write") for "Agents in this worktree".
 */
import type { QueryLogEntry, SessionId } from "@polaris/protocol";
import { Schema } from "effect";

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

/** The approval the contract is gaining (ENG-644); read structurally until it lands. */
const PendingApproval = Schema.Struct({
  approval: Schema.Struct({ status: Schema.Literal("pending") }),
});

const hasPendingApproval = Schema.is(PendingApproval);

const WRITE = /^\s*(insert|update|delete|merge|upsert|replace|alter|create|drop|truncate)\b/i;

const TABLE =
  /\b(?:from|update|into|join|table)\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/i;

export const isWrite = (sql: string) => WRITE.test(sql);

/** The first table a statement names, unquoted and without its schema; null for none. */
export const tableOf = (sql: string): string | null => {
  const name = TABLE.exec(sql)?.[1];

  if (name === undefined) return null;

  return (name.split(".").at(-1) ?? name).replace(/^["`]|["`]$/g, "");
};

/** No rows, no time and no error yet: the Query hasn't finished. */
const unfinished = (entry: QueryLogEntry) =>
  entry.rows === undefined && entry.elapsedMs === undefined && entry.error === undefined;

/**
 * A write waiting on the user: the entry's approval is pending, or (until the contract carries
 * one) an unfinished agent write whose session needs you.
 */
export const awaitsApproval = (entry: QueryLogEntry, facts: SessionFacts | null) => {
  if (hasPendingApproval(entry)) return true;

  return (
    entry.author.kind === "agent" &&
    unfinished(entry) &&
    isWrite(entry.sql) &&
    facts?.needsYou === true
  );
};

const stateOf = (entry: QueryLogEntry, facts: SessionFacts | null): LogState => {
  if (awaitsApproval(entry, facts)) return "needs-you";

  if (entry.error !== undefined) return "failed";

  return unfinished(entry) && entry.author.kind === "agent" ? "running" : "done";
};

const resultOf = (entry: QueryLogEntry, state: LogState) => {
  if (state === "failed") return entry.error ?? "";

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
    const id = sessionOf(entry);
    const state = stateOf(entry, id === null ? null : lookups.session(id));

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
 * you, else the table of its unfinished or (while it works) latest Query; null for nothing.
 */
export const dataActivity = (
  sessionId: SessionId,
  entries: ReadonlyArray<QueryLogEntry>,
  facts: SessionFacts
): string | null => {
  const own = entries.filter((e) => sessionOf(e) === sessionId);

  if (own.some((e) => awaitsApproval(e, facts))) return "Wants to write";
  const latest = own.findLast(unfinished) ?? (facts.working ? own.at(-1) : undefined);

  if (latest === undefined) return null;
  const table = tableOf(latest.sql);

  return table === null ? "Querying data" : `Querying ${table}`;
};

export const busyKey = (source: string, table: string) => `${source}\u0000${table}`;

/** Tables an agent's unfinished read is on, to the Harness reading them (the tree's dither). */
export const busyTables = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookups: LogLookups
): ReadonlyMap<string, string> => {
  const busy = new Map<string, string>();

  for (const entry of entries) {
    if (entry.author.kind !== "agent" || !unfinished(entry) || isWrite(entry.sql)) continue;
    const facts = lookups.session(entry.author.sessionId);
    const table = tableOf(entry.sql);

    if (facts?.working === true && table !== null)
      busy.set(busyKey(entry.source.name, table), facts.harness);
  }

  return busy;
};
