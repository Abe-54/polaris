/**
 * The Working strip over a table an agent is querying (DESIGN.md, Data → Working strip): the
 * Working Agent Session whose current Turn last queried this table on this Data Source. Pure.
 */
import type { HarnessKind, QueryLogEntry, SessionId } from "@polaris/protocol";
import { type LogScope, inScope, runsOnOpen, type SessionLookup } from "./queryLog.ts";

export interface TableReader {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly harness: HarnessKind;
  readonly turn: number;
  /** ISO; the strip's elapsed time counts from it. */
  readonly turnStartedAt: string;
  /** Its newest query here changes rows rather than reading them. */
  readonly writing: boolean;
}

export const tableReader = (
  entries: ReadonlyArray<QueryLogEntry>,
  lookup: SessionLookup,
  scope: Required<LogScope>
): TableReader | null => {
  let newest: { entry: QueryLogEntry; reader: TableReader } | null = null;

  for (const entry of entries) {
    const { author } = entry;

    if (author.kind === "user" || !inScope(entry, scope)) continue;

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
        writing: !runsOnOpen(entry.sql),
      },
    };
  }

  return newest?.reader ?? null;
};

/** "Fix overdue totals is reading this table", or "… is changing this table". */
export const readerTitle = (reader: TableReader) =>
  `${reader.title} is ${reader.writing ? "changing" : "reading"} this table`;
