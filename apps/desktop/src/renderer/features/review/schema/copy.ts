/**
 * The Schema Diff's words (DESIGN.md, Data → In Review; ENG-645): rows counts, where the
 * comparison starts, its caveats and why one is missing. Pure, so tested.
 */
import type { DataSchemaDiff, SchemaSourceDiff, SchemaTableDiff } from "@polaris/protocol";
import { ago } from "../overview/model/copy.ts";

type Rows = SchemaTableDiff["rows"];

/** A count with a real minus sign, as an estimate can fall. */
const figure = (n: number) => n.toLocaleString("en-US").replace("-", "−");

const rowsWord = (n: number) => (Math.abs(n) === 1 ? "row" : "rows");

/** The count alone, for the files list: "214", "~214", or "unknown"; never 0 for unknown. */
export const rowsFigure = (rows: Rows): string => {
  if (rows.kind === "unknown" || rows.value === null) return "unknown";

  return rows.kind === "estimate" ? `~${figure(rows.value)}` : figure(rows.value);
};

export const MATCHED = "matched by writes through Polaris";

/** "214 rows matched by writes through Polaris", "~214 rows · estimate", "Rows: unknown". */
export const rowsWording = (rows: Rows): string => {
  if (rows.kind === "unknown" || rows.value === null) return "Rows: unknown";

  const count = `${rowsFigure(rows)} ${rowsWord(rows.value)}`;

  return rows.kind === "estimate" ? `${count} · estimate` : `${count} ${MATCHED}`;
};

/** "200 by agents · 14 by you": the known counts by who wrote them, zeros left out. */
export const rowsSplit = (rows: Rows): string | null => {
  const parts = [
    rows.agent === undefined || rows.agent === 0 ? null : `${figure(rows.agent)} by agents`,
    rows.user === undefined || rows.user === 0 ? null : `${figure(rows.user)} by you`,
  ].filter((p) => p !== null);

  return parts.length === 0 ? null : parts.join(" · ");
};

/** The rows card's line: the wording, then the split when there is one. */
export const rowsLine = (rows: Rows): string => {
  const split = rowsSplit(rows);

  return split === null ? rowsWording(rows) : `${rowsWording(rows)} · ${split}`;
};

export const ROWS_FOOTNOTE =
  "Exact counts are rows matched by writes through Polaris, not the table’s total change. Writes made outside Polaris aren’t counted; on MySQL, matched rows that didn’t change are included.";

export const ESTIMATE_TITLE = "Estimated from the database’s table statistics";

/** Where the comparison starts, with the absolute time as its tooltip when it names one. */
export interface Provenance {
  readonly text: string;
  readonly title: string | null;
}

export interface ProvenanceContext {
  /** "Start → end of turn 7", "Across this session". */
  readonly scope: string;
  /** The Turn picked; undefined across the session. */
  readonly turn?: string | undefined;
  /** A Turn id's number as the Review shows it. */
  readonly turnNumber?: ((turn: string) => number | undefined) | undefined;
  readonly now: number;
}

const absolute = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

/** "Since the end of the previous turn", "Since turn 4 · 2 hours ago", or the scope. */
export const provenance = (source: SchemaSourceDiff, context: ProvenanceContext): Provenance => {
  if (source.baseline === "previous-turn-end")
    return { text: "Since the end of the previous turn", title: null };

  const at = source.baselineCapturedAt;

  // A baseline carried from another Turn says when it was taken.
  if (at !== undefined && source.baselineTurn !== context.turn) {
    const n =
      source.baselineTurn === undefined ? undefined : context.turnNumber?.(source.baselineTurn);

    const when = ago(at, context.now);

    return {
      text: n === undefined ? `Since ${when}` : `Since turn ${n} · ${when}`,
      title: absolute(at),
    };
  }

  if (source.baseline === "first-use")
    return { text: "Since this source was first used in the turn", title: null };

  return { text: context.scope, title: null };
};

export const CONCURRENT_NOTE =
  "Includes changes from other sessions on this database, not only this turn’s";

export const CAPTURED_LATE_NOTE =
  "Schema read after the turn started: changes made before then may be missing";

export const TRUNCATED_NOTE = "Large schema: additions and removals may be incomplete";

/** What can make the comparison say more or less than the Turn did, in order. */
export const caveats = (source: SchemaSourceDiff): ReadonlyArray<string> =>
  [
    source.concurrent === true ? CONCURRENT_NOTE : null,
    source.capturedLate === true ? CAPTURED_LATE_NOTE : null,
    source.truncated ? TRUNCATED_NOTE : null,
  ].filter((n) => n !== null);

/** Data error codes as reasons, in product words; a code not here falls back to which read failed. */
const REASONS = new Map([
  ["E-DATA-TIMEOUT", "Reading the schema timed out"],
  ["E-DATA-UNREACHABLE", "Polaris couldn’t reach the database"],
  ["E-DATA-DENIED", "Polaris wasn’t allowed to read this schema"],
  ["E-DATA-UNKNOWN-SOURCE", "This data source is no longer set up"],
  ["E-DATA-SQL", "The database refused the schema read"],
  ["E-DATA-CANCELLED", "Reading the schema was cancelled"],
]);

const DENIED_HINT = "The data source isn’t approved, or it changed during the turn";

const missing = (source: SchemaSourceDiff) => {
  if (source.beforeAt === null && source.afterAt === null) return "at the start or end of the turn";

  if (source.beforeAt === null) return "at the start of the turn";

  return source.afterAt === null ? "at the end of the turn" : null;
};

/** Why a source has no comparison: the real failure when the Daemon said, and when. */
export const unavailableReason = (source: SchemaSourceDiff): string => {
  const reason = source.errorCode === undefined ? undefined : REASONS.get(source.errorCode);
  const when = missing(source);

  if (reason !== undefined) {
    const said = when === null ? reason : `${reason} ${when}`;

    return source.errorCode === "E-DATA-DENIED" ? `${said}. ${DENIED_HINT}` : said;
  }

  return when === null
    ? "Polaris couldn’t compare the two schemas"
    : `Polaris couldn’t read this schema ${when}`;
};

/** Said when retention dropped the history asked for, so an empty diff isn't "no changes". */
export interface PrunedNote {
  readonly text: string;
  /** The files list's narrow row; `text` is its tooltip. */
  readonly short: string;
}

export const prunedNote = (diff: DataSchemaDiff | null): PrunedNote | null => {
  if (diff?.pruned !== true) return null;

  return diff.turn === undefined
    ? {
        text: "Schema snapshots of older turns are no longer kept",
        short: "Older snapshots not kept",
      }
    : { text: "Schema snapshot no longer kept for this turn", short: "Snapshot no longer kept" };
};

export const DETAILS_TRUNCATED_NOTE =
  "Partial: a wide table, so added or removed columns, indexes and constraints aren’t shown";

/** The files list's figure: "9 matched", "−12 est.", "unknown", so it never reads as a size. */
export const listFigure = (rows: Rows): string => {
  if (rows.kind === "unknown" || rows.value === null) return "unknown";

  return rows.kind === "estimate" ? `${figure(rows.value)} est.` : `${figure(rows.value)} matched`;
};
