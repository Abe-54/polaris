/**
 * Suggested Replies (ENG-884, ADR 0106): the decision that commits a `SessionReplySuggested`
 * for a session's latest Turn, from either source (the Harness's own, or Polaris's fallback).
 */
import { DomainEvent, SuggestedReply, type SuggestedReplySource } from "@polaris/protocol";
import { lastTurn, type SessionRecord } from "../store/model.ts";

/**
 * The events that offer `text` after the session's latest Turn: none when it is blank or
 * the same as the one already offered. A suggestion only ever follows the latest Turn.
 */
export const suggestReply = (
  record: SessionRecord,
  text: string,
  source: SuggestedReplySource
): ReadonlyArray<DomainEvent> => {
  const turn = lastTurn(record);
  const trimmed = text.trim();
  const current = record.session.suggestedReply;

  if (turn === undefined || trimmed === "") return [];

  if (current?.turnId === turn.id && current.text === trimmed) return [];

  return [
    DomainEvent.cases.SessionReplySuggested.make({
      sessionId: record.session.id,
      reply: SuggestedReply.make({ turnId: turn.id, text: trimmed, source }),
    }),
  ];
};
