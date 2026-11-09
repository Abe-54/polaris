/**
 * The send log tab (DESIGN.md, Requests → Sidebar; Paper Q2): the checkout's Sends grouped by
 * when, filtered by method, path, status or who sent them, each row's status, path, time and author.
 * Pure.
 */
import type { Send } from "@polaris/protocol";

export type SendGroupId = "last-hour" | "today" | "earlier";

export const SEND_GROUP_TITLES: Readonly<Record<SendGroupId, string>> = {
  "last-hour": "LAST HOUR",
  today: "EARLIER TODAY",
  earlier: "BEFORE TODAY",
};

const HOUR_MS = 60 * 60 * 1000;

/** The status lane: the HTTP status, or "—" when no response came (refused, denied, timeout…). */
export const statusLane = (send: Send) => (send.status === undefined ? "—" : String(send.status));

/** The URL's path and query, without the origin: "/invoices/overdue?limit=50". */
export const sendPath = (send: Send) => {
  try {
    const url = new URL(send.url);

    return `${url.pathname}${url.search}`;
  } catch {
    return send.url;
  }
};

/** "840 ms", "1.2 s", "30 s". */
export const duration = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;

  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
};

/** Who sent it: "you", or the agent session's title. */
export const sentBy = (send: Send, sessionTitle: (sessionId: string) => string | null) =>
  send.by.kind === "user" ? "you" : (sessionTitle(send.by.sessionId) ?? "an agent session");

export interface SendRow {
  readonly send: Send;
  readonly status: string;
  readonly path: string;
  readonly duration: string;
  readonly by: string;
}

export interface SendGroup {
  readonly id: SendGroupId;
  readonly title: string;
  readonly rows: ReadonlyArray<SendRow>;
}

const groupOf = (startedAt: string, now: Date): SendGroupId => {
  const at = new Date(startedAt);

  if (now.getTime() - at.getTime() < HOUR_MS) return "last-hour";

  return at.toDateString() === now.toDateString() ? "today" : "earlier";
};

const matches = (row: SendRow, words: ReadonlyArray<string>) => {
  const text =
    `${row.send.method} ${row.path} ${row.status} ${row.send.outcome} ${row.by}`.toLowerCase();

  return words.every((word) => text.includes(word));
};

/** The Sends as the tab lists them: newest first, grouped, only those every filter word matches. */
export const sendGroups = (
  sends: ReadonlyArray<Send>,
  filter: string,
  now: Date,
  sessionTitle: (sessionId: string) => string | null
): ReadonlyArray<SendGroup> => {
  const words = filter
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "");

  const groups = new Map<SendGroupId, Array<SendRow>>();

  const rows = sends
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
    .flatMap((send) => {
      const row = {
        send,
        status: statusLane(send),
        path: sendPath(send),
        // Nothing went out for a denied Send, so it took no time worth showing.
        duration: send.outcome === "denied" ? "—" : duration(send.durationMs),
        by: sentBy(send, sessionTitle),
      };

      return matches(row, words) ? [row] : [];
    });

  for (const row of rows) {
    const id = groupOf(row.send.startedAt, now);

    groups.set(id, [...(groups.get(id) ?? []), row]);
  }

  return (["last-hour", "today", "earlier"] as const).flatMap((id) => {
    const listed = groups.get(id);

    return listed === undefined ? [] : [{ id, title: SEND_GROUP_TITLES[id], rows: listed }];
  });
};

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "11:38", in the user's time zone. */
export const clockTime = (iso: string) => CLOCK.format(new Date(iso));
