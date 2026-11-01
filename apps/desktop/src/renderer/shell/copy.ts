/** UI copy: glossary terms lowercase (DESIGN.md rule/glossary-lowercase), what happened (rule/say-what-happened). */
import { writeWants } from "../features/data/write/model.ts";
import type { ConnectionState, SessionState } from "@polaris/protocol";
import { capacityReset } from "../features/constellation/model/failure.ts";
import { waitingOn, waitingPhrase } from "../features/session/model/background.ts";
import { secretLine } from "../features/session/model/secret.ts";
import type { SessionEntry } from "../store/hostModel.ts";
import { tildePath } from "../../shared/hostPath.ts";

export { activityOf } from "./activity.ts";

export const connectionLabel: Readonly<Record<ConnectionState, string>> = {
  connected: "connected",
  reconnecting: "reconnecting",
  "needs-attention": "needs attention",
  offline: "offline",
};

export const sessionStateLabel: Readonly<Record<SessionState, string>> = {
  starting: "starting",
  working: "working",
  "needs-you": "needs you",
  idle: "idle",
  "in-terminal": "in terminal",
  dormant: "dormant",
  failed: "failed",
  limited: "usage limit",
  archived: "archived",
};

/** "Usage limit · resets 14:00" or "Usage limit · reset time unknown", always neutral. */
export const usageLimitLine = (resetsAt: string | null | undefined) =>
  `Usage limit · ${capacityReset(resetsAt)}`;

/** The Turn number as the UI shows it: the user-Turn count, or every Turn from older Daemons. */
export const shownTurnCount = (entry: SessionEntry): number =>
  entry.session.currentUserTurn?.number ?? entry.session.turnCount;

const turnLabel = (entry: SessionEntry) => `turn ${shownTurnCount(entry)}`;

const STATE_LINES: Readonly<Record<SessionState, (entry: SessionEntry) => string>> = {
  starting: () => "Starting…",
  working: (e) => `Working · ${turnLabel(e)}`,
  "needs-you": () => "Needs you",
  idle: (e) => (shownTurnCount(e) === 0 ? "Idle" : `Idle · ${turnLabel(e)}`),
  "in-terminal": () => "In terminal",
  dormant: () => "Dormant · resumes on reply",
  failed: (e) => e.session.lastError ?? "Failed",
  limited: (e) => usageLimitLine(e.session.limitResetsAt),
  archived: () => "Archived",
};

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/**
 * A session row's second line: what the session is doing right now. A question is
 * the ask itself; an approval says what it wants to do; a Working session says
 * its current step (`activity`, from its open feed) when there is one; an Idle
 * one with background tasks says what it is waiting on.
 */
export const sessionLine = (entry: SessionEntry, activity: string | null = null): string => {
  const request = entry.pendingApprovals[0];

  if (request !== undefined) {
    if (request.kind === "secret") return secretLine(request.title);

    if (request.dataWrite !== undefined) return `W${writeWants(request.dataWrite).slice(1)}`;

    return request.kind === "question" ? request.title : `Wants to ${lowerFirst(request.title)}`;
  }

  if (entry.session.state === "working" && activity !== null) return activity;

  const waiting = waitingOn(entry.session);

  if (waiting.length > 0) return waitingPhrase(waiting);

  return STATE_LINES[entry.session.state](entry);
};

const MINUTE = 60_000;

/** "now", "42m", "5h", "3d": a row's trailing age. */
export const age = (iso: string, now: number): string => {
  const ms = now - Date.parse(iso);

  if (!Number.isFinite(ms) || ms < MINUTE) return "now";

  if (ms < 60 * MINUTE) return `${Math.floor(ms / MINUTE)}m`;

  if (ms < 24 * 60 * MINUTE) return `${Math.floor(ms / (60 * MINUTE))}h`;

  return `${Math.floor(ms / (24 * 60 * MINUTE))}d`;
};

/** A path under the Host's home as `~/…`, with the Host's own separator. */
export const homePath = (path: string, home: string | null): string => tildePath(path, home);

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
