/**
 * Waiting on Background Work (ENG-742; DESIGN.md, Constellation → Waiting on background work):
 * a worker that ended its Turn with background work out. Neutral, never needs you.
 */
import type { PhaseWaiting } from "@polaris/protocol";
import { waitingPhrase } from "../../session/model/background.ts";
import { clock } from "./copy.ts";

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** "waiting on a command", "waiting on 2 subagents", or what the worker said it waits on. */
export const waitingWords = (waiting: PhaseWaiting): string => {
  if (waiting.tasks.length > 0)
    return lowerFirst(
      waitingPhrase(waiting.tasks.map((t, i) => ({ id: String(i), kind: t.kind })))
    );

  return waiting.on === null ? "waiting on background work" : `waiting on ${waiting.on}`;
};

/** The second line: what it waits on by name, then who ends the wait. */
export const waitingDetail = (waiting: PhaseWaiting) => {
  const named = waiting.tasks.map((t) => t.description).filter((d) => d !== "");

  if (named.length > 0) return { text: named.join(" · "), detail: "wakes when it ends" };

  return {
    text: waiting.on ?? "background work ended",
    detail: `back by ${clock(new Date(waiting.until).toISOString())}`,
  };
};
