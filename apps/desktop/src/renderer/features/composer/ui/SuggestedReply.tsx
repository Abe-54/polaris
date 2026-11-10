/**
 * The Suggested Reply in the empty prompt, where the placeholder would be (DESIGN.md,
 * "Suggested Replies in the composer"): ghost text, then a `⇥ Tab` keycap that accepts it.
 */
import { Kbd } from "@polaris/ui";
import type { OfferedReply } from "../model/suggestion.ts";

/** Said once to screen readers when the reply appears. */
export const replyAnnouncement = (text: string) => `Suggested reply: ${text}. Press Tab to use it.`;

export const SuggestedReplyGhost = ({
  reply,
  onAccept,
}: {
  readonly reply: OfferedReply;
  readonly onAccept: () => void;
}) => (
  <div
    data-testid="suggested-reply"
    className="text-body pointer-events-none absolute inset-x-0 top-0 flex min-w-0 items-center gap-1.5 select-none"
  >
    <span aria-hidden="true" className="text-text-subtle min-w-0 truncate">
      {reply.text.replaceAll(/\s+/g, " ")}
    </span>
    <button
      type="button"
      aria-label="Use suggested reply"
      data-testid="suggested-reply-accept"
      className="focus-visible:ring-starlight pointer-events-auto shrink-0 cursor-default rounded-[4px] outline-none focus-visible:ring-2"
      // The prompt keeps focus, so the caret lands after the inserted text.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAccept}
    >
      <Kbd className="gap-1 px-1.5">⇥ Tab</Kbd>
    </button>
  </div>
);
