/**
 * The history tools' rows (`sessions`, `search_history`, `read_history`): what was asked as the
 * subject, how much came back as the caption, and the sessions they name, which open from the row.
 */
import type { ReadHistoryInput, SearchHistoryInput, SessionsInput } from "./inputs.ts";
import { clock, transcriptTurns } from "./lead.ts";
import type { ToolResult } from "./result.ts";
import type { Built, HistoryRow, Segment, SessionRef } from "./types.ts";
import { count, quote } from "./words.ts";

// `sessionLine` in the Daemon's mcp/sessions/history.ts.
const SESSION = /^- (\S+) · "(.*)" · (\S+) · (\S+) · (\d+) Turns · updated (\S+)(.*)$/;

// `hitLine` there: the session only outside scope session.
const HIT = /^- (?:(\S+) "(.*)" · )?Turn (\d+) · (\S+) · (\w+): (.*)$/;

const MATCHES = /^(\d+|No) matches? /;

const SESSIONS = /^(\d+) sessions/;

const READ = /^Session (\S+)$/;

const titled = (id: string, title: string): SessionRef => ({ id, title: title || "Untitled" });

const where = (scope: string | undefined, session: string | undefined): Segment => {
  if (scope === "host") return { text: "on this host" };

  if (scope === "workspace") return { text: "in this workspace" };

  return { text: session === undefined ? "in this session" : `in ${session}` };
};

const sessionRow = (line: string): HistoryRow | null => {
  const m = SESSION.exec(line);

  if (m === null) return null;
  const [, id = "", title = "", harness, state, turns = "0", , rest = ""] = m;
  const here = rest.includes("(this session)") ? ["this session"] : [];

  return {
    session: titled(id, title),
    heading: [harness, state, count(Number(turns), "Turn"), ...here].join(" · "),
    text: null,
  };
};

const hitRow = (line: string): HistoryRow | null => {
  const m = HIT.exec(line);

  if (m === null) return null;
  const [, id, title = "", turn, at, source = "", snippet = ""] = m;

  return {
    session: id === undefined ? null : titled(id, title),
    heading: [`Turn ${turn}`, source, clock(at)].filter((p) => p !== null).join(" · "),
    text: snippet,
  };
};

const rowsOf = (result: ToolResult | null, row: (line: string) => HistoryRow | null) =>
  (result?.body ?? []).flatMap((line) => row(line) ?? []);

const historyWell = (rows: ReadonlyArray<HistoryRow>) =>
  rows.length === 0 ? null : { kind: "history" as const, rows };

export const sessions = (
  { scope, query }: typeof SessionsInput.Type,
  result: ToolResult | null
): Built => {
  const listed = SESSIONS.exec(result?.summary ?? "")?.[1];

  return {
    head: {
      verbs: ["Listing sessions", "Listed sessions", "list sessions"],
      subject: query === undefined || query === "" ? null : quote(query),
      detail: [where(scope ?? "workspace", undefined)],
      caption: listed === undefined ? null : count(Number(listed), "session"),
    },
    well: historyWell(rowsOf(result, sessionRow)),
    links: [],
  };
};

export const searchHistory = (
  { query = "", scope, session }: typeof SearchHistoryInput.Type,
  result: ToolResult | null
): Built => {
  const found = MATCHES.exec(result?.summary ?? "")?.[1];

  const caption =
    found === undefined
      ? null
      : found === "No"
        ? "no matches"
        : count(Number(found), "match", "matches");

  return {
    head: {
      verbs: ["Searching history for", "Searched history for", "search history for"],
      subject: quote(query),
      detail: [where(scope, session)],
      caption,
    },
    well: historyWell(rowsOf(result, hitRow)),
    links: [],
  };
};

export const readHistory = (
  { session, turns = 2, since }: typeof ReadHistoryInput.Type,
  result: ToolResult | null
): Built => {
  const which = since === undefined ? `last ${count(turns, "Turn")}` : `Turns from ${since}`;
  const parsed = result === null ? [] : transcriptTurns(result.body);
  const id = READ.exec(result?.summary ?? "")?.[1];

  return {
    head: {
      verbs: ["Reading", "Read", "read"],
      subject: { text: `${session ?? "this session"}'s ${which}` },
      detail: [],
      caption: null,
    },
    well: parsed.length === 0 ? null : { kind: "turns", turns: parsed },
    links: [],
    sessions: id === undefined || session === undefined ? [] : [titled(id, session)],
  };
};
