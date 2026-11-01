/**
 * The write approval's words (DESIGN.md, Data → Approvals; Paper D3): the verb its statement
 * makes, the dry run's kicker, Run's label, the before/after cells that changed, the remote top
 * bar and the line a settled card collapses to. Pure, so tested.
 */
import type {
  ApprovalDecision,
  ApprovalRequest,
  DataSource,
  DataValue,
  QueryLogEntry,
} from "@polaris/protocol";
import { Decisions } from "../../../commands.ts";
import { cellOf, displayOf } from "../grid/value.ts";
import type { WriteOutcome } from "../../../store/sessionModel.ts";
import type { LabelColour } from "../model/source.ts";
import { maskLiterals } from "../sql/literals.ts";

export type DataWrite = NonNullable<ApprovalRequest["dataWrite"]>;

/** The write an approval asks to run; null for any other approval. */
export const dataWriteOf = (request: ApprovalRequest): DataWrite | null =>
  request.dataWrite ?? null;

export type WriteVerb = "update" | "insert" | "delete" | "write" | "schema change";

const VERBS: ReadonlyArray<readonly [RegExp, WriteVerb]> = [
  [/^(update)\b/i, "update"],
  [/^(insert|replace)\b/i, "insert"],
  [/^(delete)\b/i, "delete"],
  [/^(create|alter|drop|truncate|comment|rename)\b/i, "schema change"],
];

/** The statement after a leading `WITH …` list: the first keyword outside its parentheses. */
const afterCtes = (masked: string): string => {
  if (!/^with\b/i.test(masked)) return masked;
  let depth = 0;

  for (let i = 4; i < masked.length; i++) {
    const char = masked[i];

    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && /^(select|insert|update|delete|merge)\b/i.test(masked.slice(i)))
      return masked.slice(i);
  }

  return masked;
};

/** "update", "insert", "delete", a "schema change" for DDL; "write" for anything else. */
export const verbOf = (sql: string): WriteVerb => {
  const statement = afterCtes(maskLiterals(sql).trim());

  return VERBS.find(([pattern]) => pattern.test(statement))?.[1] ?? "write";
};

const rows = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

/** "$1 = 42 · $2 = 'USD'": what the statement binds; empty when it binds nothing. */
export const paramsLine = (write: DataWrite): ReadonlyArray<string> =>
  (write.params ?? []).map((value, i) => `$${i + 1} = ${displayOf(cellOf(value))}`);

/** Not previewed: the Daemon ran no dry run (DDL, triggers), so there are no rows to show. */
export const notPreviewed = (write: DataWrite): boolean => write.previewed === false;

const NOT_PREVIEWED = "Not previewed";

/** Why there was no dry run, in the Daemon's words ("Not previewed: this table has triggers"). */
const notPreviewedReason = (write: DataWrite) =>
  write.note.trim().startsWith(NOT_PREVIEWED) ? write.note.trim() : NOT_PREVIEWED;

/**
 * The lines under the rows, from the Daemon's typed facts: what the preview left out, how rows
 * pair up, and an insert's IDs. An older Daemon's note stands in; an unpreviewed write has none.
 */
export const noteLines = (write: DataWrite): ReadonlyArray<string> => {
  if (notPreviewed(write)) return [];
  const facts = write.previewFacts;

  if (facts === undefined) return write.note.trim() === "" ? [] : [write.note.trim()];
  const verb = verbOf(write.sql);

  return [
    facts.truncated ? "Some rows or columns aren't shown." : null,
    !facts.readByKey && (verb === "update" || verb === "delete")
      ? "No primary key: rows are paired in the order they were read."
      : null,
    facts.sequences && verb === "insert"
      ? "IDs the preview used are skipped; the run gets new ones."
      : null,
  ].filter((line) => line !== null);
};

/** Under an unpreviewed write's kicker: what the card can't show, so it reads as the riskier one. */
export const notPreviewedWarning = (write: DataWrite) =>
  verbOf(write.sql) === "schema change"
    ? "Polaris can't show what this changes in the schema."
    : "Polaris can't show which rows this changes.";

/** An insert's preview holds only the new rows. */
const isInsert = (write: DataWrite) => verbOf(write.sql) === "insert";

/** "214 rows", or "3 new rows" for an insert. */
export const rowsWording = (write: DataWrite) =>
  isInsert(write)
    ? `${write.affected.toLocaleString("en-US")} new ${write.affected === 1 ? "row" : "rows"}`
    : rows(write.affected);

/** "Dry run · rolled back · 214 rows"; a schema change counts no rows; unpreviewed, no dry run. */
export const dryRunKicker = (write: DataWrite) => {
  if (notPreviewed(write)) return notPreviewedReason(write);

  return verbOf(write.sql) === "schema change"
    ? "Dry run · rolled back"
    : `Dry run · rolled back · ${rowsWording(write)}`;
};

/** "214-row update", "1-row delete", "schema change", "update without preview". */
export const writeName = (write: DataWrite) => {
  const verb = verbOf(write.sql);

  if (verb === "schema change") return verb;

  return notPreviewed(write)
    ? `${verb} without preview`
    : `${write.affected.toLocaleString("en-US")}-row ${verb}`;
};

/** The primary action: "Run 214-row update", or "Run without preview". */
export const runLabel = (write: DataWrite) =>
  notPreviewed(write) ? "Run without preview" : `Run ${writeName(write)}`;

/** "showing 20 of 214" when the preview holds fewer rows than the write changes; else null. */
export const showingLine = (write: DataWrite): string | null => {
  if (notPreviewed(write)) return null;
  const shown = Math.max(write.before.length, write.after.length);

  return shown < write.affected
    ? `showing ${shown.toLocaleString("en-US")} of ${write.affected.toLocaleString("en-US")}`
    : null;
};

/** One cell of the before/after table, and whether the write changes it. */
export type CellChange = "same" | "changed" | "added" | "removed";

const sameValue = (a: DataValue | undefined, b: DataValue | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const cellKey = (row: number, column: number) => `${row}:${column}`;

/** Credential cells the Daemon redacted on both sides, and whether the write changes each. */
const redactions = (write: DataWrite): ReadonlyMap<string, boolean> =>
  new Map((write.redactedCells ?? []).map((c) => [cellKey(c.row, c.column), c.changed]));

/** What a cell shows instead of its value: redacted, or a value the database assigns on run. */
export type CellStandIn =
  | { readonly kind: "redacted"; readonly changed: boolean }
  | { readonly kind: "assigned" };

/** A preview cell's stand-in, by row and column; null when its value is the one to show. */
export const cellStandIns = (
  write: DataWrite
): ((row: number, column: number, side: "before" | "after") => CellStandIn | null) => {
  const redacted = redactions(write);
  const filled = new Set(write.databaseFilledColumns ?? []);

  return (row, column, side) => {
    const changed = redacted.get(cellKey(row, column));

    if (changed !== undefined) return { kind: "redacted", changed };
    const name = write.columns[column];

    return side === "after" && isInsert(write) && name !== undefined && filled.has(name)
      ? { kind: "assigned" }
      : null;
  };
};

/**
 * Each preview row's change per column: an insert's rows are all added, a delete's all removed;
 * an update's cells changed where before and after differ, or where the Daemon says a redacted one did.
 */
export const cellChanges = (write: DataWrite): ReadonlyArray<ReadonlyArray<CellChange>> => {
  const count = Math.max(write.before.length, write.after.length);
  const redacted = redactions(write);

  return Array.from({ length: count }, (_, row) => {
    const before = write.before[row];
    const after = write.after[row];

    return write.columns.map((_, col): CellChange => {
      if (before === undefined) return "added";

      if (after === undefined) return "removed";
      const changed = redacted.get(cellKey(row, col));

      if (changed !== undefined) return changed ? "changed" : "same";

      return sameValue(before[col], after[col]) ? "same" : "changed";
    });
  });
};

/** Columns any row changes, so a wide table can lead with them. */
export const changedColumns = (write: DataWrite): ReadonlySet<number> => {
  const changed = new Set<number>();

  for (const row of cellChanges(write))
    row.forEach((change, col) => {
      if (change !== "same") changed.add(col);
    });

  return changed;
};

/** The colour a remote source's card takes on its top bar (rule/data-source-label); else null. */
export const topBarColour = (source: DataSource | undefined): LabelColour | null =>
  source?.locality === "remote" && source.label.colour !== "none" ? source.label.colour : null;

/** The SQL folds behind "Show all" past this many lines or characters. */
export const SQL_FOLD_LINES = 6;

export const SQL_FOLD_CHARS = 600;

export const isLongSql = (sql: string) =>
  sql.length > SQL_FOLD_CHARS || sql.split("\n").length > SQL_FOLD_LINES;

/** A long statement's first lines, as the folded card shows it. */
export const foldedSql = (sql: string) =>
  sql.split("\n").slice(0, SQL_FOLD_LINES).join("\n").slice(0, SQL_FOLD_CHARS);

export const DENY_PROMPT = "Deny and tell the agent why";

/** A Deny the agent can act on: the reason is required, trimmed. Null until there is one. */
export const denyDecision = (reason: string): ApprovalDecision | null => {
  const text = reason.trim();

  return text === "" ? null : Decisions.Deny({ reason: text });
};

/** Run once: a write is never remembered, each one asks. */
export const runDecision = (): ApprovalDecision => Decisions.Allow({ remember: false });

/** What the card says once answered, from the decision and what the Query Log saw since. */
export type Settled =
  | { readonly kind: "ran"; readonly line: string }
  | { readonly kind: "running"; readonly line: string }
  | { readonly kind: "allowed"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string; readonly detail: string }
  | { readonly kind: "cancelled"; readonly line: string }
  | { readonly kind: "unknown"; readonly line: string; readonly detail: string }
  | { readonly kind: "denied"; readonly line: string }
  | { readonly kind: "expired"; readonly line: string; readonly detail?: string };

const EXPIRED = {
  harness: "Expired: the turn ended before you answered",
  daemon: "Expired: the daemon restarted before you answered",
} as const;

/** The Daemon's withdrawal reasons (engine/session.ts), in the card's words. */
const EXPIRED_BY_REASON = new Map([
  ["The Turn ended", EXPIRED.harness],
  ["The Daemon restarted", EXPIRED.daemon],
  ["The Daemon is upgrading", "Expired: the daemon upgraded before you answered"],
  ["Interrupted", "Expired: the turn was stopped before you answered"],
  ["The session was archived", "Expired: the session was archived"],
  ["The terminal UI closed", "Expired: the terminal closed before you answered"],
  ["The Harness exited", "Expired: the agent exited before you answered"],
]);

/** Why a write expired unanswered: a known reason in product words; else the agent's error. */
export const expiredLine = (
  by: "harness" | "daemon" | null,
  reason: string | null | undefined
): Extract<Settled, { kind: "expired" }> => {
  const text = reason?.trim() ?? "";

  if (text === "")
    return { kind: "expired", line: by === null ? "Expired before you answered" : EXPIRED[by] };
  const known = EXPIRED_BY_REASON.get(text);

  return known === undefined
    ? { kind: "expired", line: "Expired: the agent stopped with an error", detail: text }
    : { kind: "expired", line: known };
};

/** The failure's own words, else a fix the user can act on. */
const failureDetail = (entry: QueryLogEntry) =>
  entry.error?.trim() || "The database refused the write. Open the query log for what it ran.";

/** The Daemon lost the COMMIT's confirmation (E-DATA-OUTCOME-UNKNOWN): it may or may not have run. */
export const outcomeUnknown = (entry: QueryLogEntry | undefined) => entry?.state === "unknown";

export const UNKNOWN_DETAIL =
  "Polaris lost track of this write before the database confirmed it. Check the rows before asking the agent to try again.";

const allowedLine = (write: DataWrite, entry: QueryLogEntry | undefined): Settled => {
  const name = writeName(write);

  if (outcomeUnknown(entry))
    return { kind: "unknown", line: `${name}: outcome unknown`, detail: UNKNOWN_DETAIL };

  switch (entry?.state) {
    case "running":
      return { kind: "running", line: `Running ${name}…` };
    case "completed":
      return {
        kind: "ran",
        line:
          entry.rows === undefined || verbOf(write.sql) === "schema change"
            ? `Ran ${name}`
            : `Ran ${entry.rows.toLocaleString("en-US")}-row ${verbOf(write.sql)}`,
      };
    case "failed":
      return { kind: "failed", line: `${name} failed`, detail: failureDetail(entry) };
    case "cancelled":
      // An answered approval the agent hasn't run yet reads cancelled until it retries.
      return entry.approval?.status === "approved"
        ? { kind: "allowed", line: `Allowed ${name}` }
        : { kind: "cancelled", line: `Cancelled ${name}` };
    default:
      return { kind: "allowed", line: `Allowed ${name}` };
  }
};

/** "Ran 214-row update", "Denied: wrong currency", "Expired: the turn ended before you answered". */
export const settledLine = (
  write: DataWrite,
  outcome: WriteOutcome,
  entry: QueryLogEntry | undefined
): Settled => {
  switch (outcome.kind) {
    case "allowed":
      return allowedLine(write, entry);
    case "denied":
      return {
        kind: "denied",
        line: outcome.reason === null ? "Denied" : `Denied: ${outcome.reason}`,
      };
    case "expired":
      return expiredLine(outcome.by, outcome.reason);
  }
};

/** The write's run in the Query Log: the entry the preview logged under the approval's query id. */
export const writeEntry = (
  entries: ReadonlyArray<QueryLogEntry>,
  write: DataWrite
): QueryLogEntry | undefined => entries.find((e) => e.id === write.queryId);

/** "wants to run a 214-row update on app": a write's ask, after the session's title. */
export const writeWants = (write: DataWrite) => {
  const name = writeName(write);
  const article = /^[aeiou8]|^1[18](?:,\d{3})*-/i.test(name) ? "an" : "a";

  return `wants to run ${article} ${name} on ${write.target.sourceName}`;
};
