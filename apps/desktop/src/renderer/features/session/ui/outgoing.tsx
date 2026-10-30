/**
 * The user's own messages after the prompt: a steer where it landed in the
 * Turn, and a steer or queued follow-up still on its way, faded, with what it
 * waits for, or why it didn't land and how to send it again.
 */
import { Button, cn, PixelFailedIcon } from "@polaris/ui";
import type { ReactNode } from "react";
import { SentAttachments } from "../../attachments/index.ts";
import type { Outgoing } from "../model/outbox.ts";
import { softWrap } from "./softWrap.tsx";

const BUBBLE =
  "rounded-card bg-fill-selected text-body text-text-strong py-row-x max-w-[340px] px-3.5 break-words whitespace-pre-wrap";

const Bubble = ({
  text,
  faded = false,
  above = null,
  children,
  testId,
}: {
  readonly text: string;
  readonly faded?: boolean;
  /** What the message carries, above it. */
  readonly above?: ReactNode;
  readonly children: ReactNode;
  readonly testId: string;
}) => (
  <div className="flex flex-col items-end gap-1.5" data-testid={testId}>
    {above}
    {text === "" ? null : (
      <p className={cn(BUBBLE, "transition-opacity duration-200 ease-out", faded && "opacity-60")}>
        {softWrap(text)}
      </p>
    )}
    <div className="text-caption text-text-subtle flex h-5 max-w-[340px] items-center gap-2">
      {children}
    </div>
  </div>
);

/** A steer the Harness took, in the Turn where it landed. */
export const Steered = ({
  text,
  above = null,
  time = null,
}: {
  readonly text: string;
  /** The attachments it carried. */
  readonly above?: ReactNode;
  readonly time?: ReactNode;
}) => (
  <Bubble text={text} above={above} testId="steered">
    Steered this turn
    {time === null ? null : <span aria-hidden="true">·</span>}
    {time}
  </Bubble>
);

export interface OutgoingProps {
  readonly entry: Outgoing;
  /** The session's Host, where its attachments are staged. */
  readonly hostKey: string;
  /** A Turn is in flight that takes steers: a failed steer retries as one. */
  readonly canSteer: boolean;
  readonly onRetry: () => void;
  readonly onEdit: () => void;
}

const waitingLabel = (entry: Outgoing): string => {
  if (entry.kind === "steer") return "Steering…";

  return entry.status === "waiting" ? "Queued for after this turn" : "Sending…";
};

export const OutgoingMessage = ({ entry, hostKey, canSteer, onRetry, onEdit }: OutgoingProps) => {
  const above = <SentAttachments hostKey={hostKey} attachments={entry.attachments} />;

  if (entry.status !== "failed")
    return (
      <Bubble text={entry.text} faded above={above} testId="outgoing">
        <span data-testid="outgoing-status">{waitingLabel(entry)}</span>
        {entry.status === "waiting" ? (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Cancel
          </Button>
        ) : null}
      </Bubble>
    );
  const again = entry.kind === "steer" && !canSteer ? "Send as next turn" : "Retry";

  return (
    <Bubble text={entry.text} above={above} testId="outgoing-failed">
      <PixelFailedIcon size={12} className="text-failed shrink-0" />
      <span className="min-w-0 truncate" data-testid="outgoing-status">
        {entry.error ?? (entry.kind === "steer" ? "Couldn't steer" : "Couldn't send")}
      </span>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        {again}
      </Button>
    </Bubble>
  );
};
