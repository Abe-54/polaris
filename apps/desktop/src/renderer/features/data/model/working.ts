/**
 * The Working strip over a table an agent is querying (DESIGN.md, Data → Working strip): the
 * Working Agent Session whose current Turn is querying this table on this Data Source now. Pure.
 */
import type { HarnessKind, QueryLogEntry, SessionId, TurnId } from "@polaris/protocol";
import { inScope, isWrite, type LogScope } from "./queryLog.ts";

/** What the strip needs of an Agent Session: is it Working, and on which Turn since when. */
export interface WorkingFacts {
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

/** null when the session isn't on this Host's list. */
export type WorkingLookup = (id: SessionId) => WorkingFacts | null;

export interface TableReader {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly harness: HarnessKind;
  readonly turn: number;
  /** ISO; the strip's elapsed time counts from it. */
  readonly turnStartedAt: string;
  /** What its query does: reads, changes rows, or waits on the user to change them. */
  readonly verb: "reading" | "changing" | "wants-to-change";
}

/** Only a query in flight shows: running, or a write held for the user. */
const verbOf = (entry: QueryLogEntry): TableReader["verb"] | null => {
  if (entry.state === "waiting-approval") return "wants-to-change";

  if (entry.state !== "running") return null;

  return isWrite(entry.sql) ? "changing" : "reading";
};

export const tableReader = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookup: WorkingLookup,
  scope: Required<LogScope>
): TableReader | null => {
  let newest: { entry: QueryLogEntry; reader: TableReader } | null = null;

  for (const entry of entries) {
    const { author } = entry;

    const verb = verbOf(entry);

    if (author.kind === "user" || verb === null || !inScope(entry, scope)) continue;

    if (newest !== null && newest.entry.at >= entry.at) continue;
    const facts = lookup(author.sessionId);

    if (facts === null || !facts.working || facts.turn?.id !== author.turn) continue;
    newest = {
      entry,
      reader: {
        sessionId: author.sessionId,
        title: facts.title,
        harness: facts.harness,
        turn: facts.turn.number,
        turnStartedAt: facts.turn.startedAt,
        verb,
      },
    };
  }

  return newest?.reader ?? null;
};

const PHRASE: Readonly<Record<TableReader["verb"], string>> = {
  reading: "is reading",
  changing: "is changing",
  "wants-to-change": "wants to change",
};

/** "Fix overdue totals is reading this table", "… is changing …", "… wants to change …". */
export const readerTitle = (reader: TableReader) =>
  `${reader.title} ${PHRASE[reader.verb]} this table`;
