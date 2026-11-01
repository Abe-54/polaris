import type { HTMLAttributes, ReactNode } from "react";

import { PixelHandIcon } from "../../icons/pixel";
import { cn } from "../../lib/cn";
import type { Harness } from "../../lib/hue";
import { Button } from "../ui/button";
import { CodeWell } from "./code-well";
import { Tile } from "./tile";

export interface NeedsYouCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly harness: Harness;
  /** The Agent Session's title. */
  readonly title: ReactNode;
  /** "Host · Workspace · age". */
  readonly where: ReactNode;
  /** An approval: the command, and Approve / Always here / Deny. */
  readonly approval?: {
    readonly command: string;
    readonly onApprove?: () => void;
    readonly onAlwaysAllow?: () => void;
    readonly onDeny?: () => void;
  };
  /** A question: shown here, answered in the conversation (QuestionCard). */
  readonly question?: ReactNode;
  readonly selected?: boolean;
}

/**
 * One waiting session in the Needs You inbox (DESIGN.md, Needs You inbox; Paper 1G2-0). Cards,
 * not rows, because each is an object the user acts on (rule/no-dashboard-clutter).
 */
export function NeedsYouCard({
  harness,
  title,
  where,
  approval,
  question,
  selected = false,
  className,
  ...props
}: NeedsYouCardProps) {
  return (
    <div
      data-slot="needs-you-card"
      data-selected={selected ? "" : undefined}
      className={cn(
        "flex flex-col gap-2.5 rounded-card border bg-surface-raised p-3",
        selected ? "border-text-subtle/40" : "border-hairline",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5">
        <Tile hue={harness} size={28}>
          <PixelHandIcon size={14} className="text-needs-you" />
        </Tile>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <p className="text-label text-text-strong truncate">{title}</p>
          <p className="text-caption text-text-subtle truncate">{where}</p>
        </div>
      </div>
      {approval === undefined ? null : (
        <>
          <CodeWell size="sm" className="border-transparent">
            {approval.command}
          </CodeWell>
          <div className="flex gap-1.5">
            <Button variant="primary" size="xs" onClick={approval.onApprove}>
              Approve
            </Button>
            {approval.onAlwaysAllow === undefined ? null : (
              <Button size="xs" className="px-2" onClick={approval.onAlwaysAllow}>
                Always here
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" size="xs" className="px-1.5" onClick={approval.onDeny}>
              Deny
            </Button>
          </div>
        </>
      )}
      {question === undefined ? null : (
        <p className="text-caption text-text-default leading-[17px]">{question}</p>
      )}
    </div>
  );
}

export interface WaitingCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Failed needs a retry, In Terminal taking back, an Interrupted Turn (after a restart) Continue. */
  readonly kind: "failed" | "in-terminal" | "interrupted";
  /** A 14px glyph: the pixel failed or terminal icon. */
  readonly icon: ReactNode;
  readonly title: ReactNode;
  /** "Failed · out of memory on Pi 4", "In your terminal". */
  readonly detail: ReactNode;
  /** The single action: "Retry" or "Take back". */
  readonly action: { readonly label: string; readonly onAction: () => void };
}

/** A compact "Also waiting on you" card: one line of state and a single action. */
export function WaitingCard({
  kind,
  icon,
  title,
  detail,
  action,
  className,
  ...props
}: WaitingCardProps) {
  return (
    <div
      data-slot="waiting-card"
      data-kind={kind}
      className={cn(
        "flex items-center gap-2.5 rounded-card border border-hairline bg-surface-raised px-3 py-2.5",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-[8px] border",
          kind === "failed"
            ? "border-failed/14 bg-failed/8 text-failed"
            : "border-transparent bg-surface-sunken text-text-subtle"
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <p className="text-label text-text-strong truncate">{title}</p>
        <p className="text-caption text-text-subtle truncate">{detail}</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        className="text-text-default px-1.5"
        onClick={action.onAction}
      >
        {action.label}
      </Button>
    </div>
  );
}
