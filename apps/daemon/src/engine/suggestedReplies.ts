/**
 * Suggested Replies (ENG-884, ADR 0106): the decision that commits a `SessionReplySuggested`
 * for a session's latest Turn, from either source (the Harness's own, or Polaris's fallback).
 */
import {
  DomainEvent,
  SuggestedReply,
  type SuggestedReplySource,
  type TurnId,
} from "@polaris/protocol";
import { lastTurn, type SessionRecord, workingTurn } from "../store/model.ts";

/**
 * The events that offer `text` after `turnId`, the Turn it was written for: none unless that
 * Turn is still the latest and has ended, nor when the text is blank or already offered.
 */
export const suggestReply = (
  record: SessionRecord,
  turnId: TurnId,
  text: string,
  source: SuggestedReplySource
): ReadonlyArray<DomainEvent> => {
  const trimmed = text.trim();
  const current = record.session.suggestedReply;
  const stale = lastTurn(record)?.id !== turnId || workingTurn(record) !== undefined;

  if (stale || trimmed === "") return [];

  if (current?.turnId === turnId && current.text === trimmed) return [];

  return [
    DomainEvent.cases.SessionReplySuggested.make({
      sessionId: record.session.id,
      reply: SuggestedReply.make({ turnId, text: trimmed, source }),
    }),
  ];
};
