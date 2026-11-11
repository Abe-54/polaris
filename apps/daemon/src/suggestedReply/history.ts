/** The user's own past messages, so the fallback writes in their voice (ENG-928). */
import { isWorkerSession, type Turn } from "@polaris/protocol";
import type { ReadModel } from "../store/model.ts";

/** Past messages the prompt quotes, newest first. */
export const HISTORY_MESSAGES = 30;

/** A longer message is cut: its opening shows the voice well enough. */
export const HISTORY_MESSAGE_CHARS = 280;

/** A Turn whose prompt the user typed: not a trigger, Review feedback, shell or compaction. */
const typed = (turn: Turn) =>
  turn.trigger == null &&
  turn.feedback == null &&
  turn.shellCommand == null &&
  turn.idleCompaction !== true &&
  turn.prompt.trim() !== "";

/**
 * The user's latest typed prompts across their own sessions on this Host (not a Reviewer's or
 * a worker's, whose prompts an agent wrote), newest first,
 * without the Turns in `skip` (the conversation the prompt already holds) or repeats.
 */
export const pastMessages = (
  model: ReadModel,
  skip: ReadonlySet<Turn["id"]>
): ReadonlyArray<string> => {
  const turns = [...model.sessions.values()]
    .filter(({ session }) => session.origin == null && !isWorkerSession(session))
    .flatMap((record) => record.turns.filter((turn) => typed(turn) && !skip.has(turn.id)))
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));

  const seen = new Set<string>();
  const messages: Array<string> = [];

  for (const turn of turns) {
    const text = turn.prompt.trim().replaceAll(/\s+/g, " ").slice(0, HISTORY_MESSAGE_CHARS);

    if (seen.has(text)) continue;
    seen.add(text);
    messages.push(text);

    if (messages.length === HISTORY_MESSAGES) break;
  }

  return messages;
};
