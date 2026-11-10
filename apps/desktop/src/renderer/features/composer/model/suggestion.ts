/**
 * The Suggested Reply the composer may offer (ENG-885, DESIGN.md "Suggested Replies in the
 * composer"): only while the session is Idle, and only for its latest Turn.
 */
import type { SessionState, SuggestedReply } from "@polaris/protocol";

export interface OfferedReply {
  /** The Turn it follows; a dismissal holds for this Turn only. */
  readonly turnId: string;
  readonly text: string;
}

export const offeredReply = (
  state: SessionState,
  reply: SuggestedReply | null | undefined,
  latestTurnId: string | null
): OfferedReply | null => {
  if (state !== "idle" || reply == null || reply.turnId !== latestTurnId) return null;
  const text = reply.text.trim();

  return text === "" ? null : { turnId: reply.turnId, text };
};
