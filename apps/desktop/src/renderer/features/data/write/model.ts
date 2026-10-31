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
import { DataValue as DataValueSchema } from "@polaris/protocol";
import { Option, Schema } from "effect";
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

/**
 * WF's additions (RW F1/F4), read here until the protocol has them: the bound params, and a write
 * the Daemon couldn't preview (a table with triggers), as WF plans them; reconciled at merge.
 */
const WfFields = Schema.Struct({
  params: Schema.optionalKey(Schema.Array(DataValueSchema)),
  previewed: Schema.optionalKey(Schema.Boolean),
});

const wfFields = (write: DataWrite) =>
  Option.getOrElse(Schema.decodeUnknownOption(WfFields)(write), (): typeof WfFields.Type => ({}));

/** "$1 = 42 · $2 = 'USD'": what the statement binds; empty when it binds nothing. */
export const paramsLine = (write: DataWrite): ReadonlyArray<string> =>
  (wfFields(write).params ?? []).map((value, i) => `$${i + 1} = ${displayOf(cellOf(value))}`);

/** Not previewed: the Daemon ran no dry run, so there are no rows to show. */
export const notPreviewed = (write: DataWrite): boolean => wfFields(write).previewed === false;

export const NOT_PREVIEWED = "Not previewed: this table has triggers";

/** An insert's preview holds only the new rows. */
const isInsert = (write: DataWrite) => verbOf(write.sql) === "insert";

/** "214 rows", or "3 new rows" for an insert. */
export const rowsWording = (write: DataWrite) =>
  isInsert(write)
    ? `${write.affected.toLocaleString("en-US")} new ${write.affected === 1 ? "row" : "rows"}`
    : rows(write.affected);

/** "Dry run · rolled back · 214 rows"; a schema change counts no rows; unpreviewed, no dry run. */
export const dryRunKicker = (write: DataWrite) => {
  if (notPreviewed(write)) return NOT_PREVIEWED;

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

/**
 * Each preview row's change per column: an insert's rows are all added, a delete's all removed;
 * an update's cells changed where before and after differ.
 */
export const cellChanges = (write: DataWrite): ReadonlyArray<ReadonlyArray<CellChange>> => {
  const count = Math.max(write.before.length, write.after.length);

  return Array.from({ length: count }, (_, row) => {
    const before = write.before[row];
    const after = write.after[row];

    return write.columns.map((_, col): CellChange => {
      if (before === undefined) return "added";

      if (after === undefined) return "removed";

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
  | { readonly kind: "denied"; readonly line: string }
  | { readonly kind: "expired"; readonly line: string };

const EXPIRED = {
  harness: "Expired: the turn ended before you answered",
  daemon: "Expired: the daemon restarted before you answered",
} as const;

/** The failure's own words, else a fix the user can act on. */
const failureDetail = (entry: QueryLogEntry) =>
  entry.error?.trim() || "The database refused the write. Open the query log for what it ran.";

const allowedLine = (write: DataWrite, entry: QueryLogEntry | undefined): Settled => {
  const name = writeName(write);

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
      return { kind: "expired", line: EXPIRED[outcome.by] };
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
