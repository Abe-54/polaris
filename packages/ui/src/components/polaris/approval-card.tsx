import type { HTMLAttributes, ReactNode } from "react";

import { PixelHandIcon } from "../../icons/pixel";
import { cn } from "../../lib/cn";
import type { Harness } from "../../lib/hue";
import { Button } from "../ui/button";
import { CodeWell } from "./code-well";
import { Kbd } from "./kbd";
import { Tile } from "./tile";

export interface ApprovalCardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly harness: Harness;
  /** The Agent Session's title. */
  readonly title: ReactNode;
  /** What it wants, with the age: "Codex wants to run a command · 42m". */
  readonly summary: ReactNode;
  /** The exact command, in a sunken well. */
  readonly command: string;
  /** "Mac Studio · polaris · ⎇ spike/gpui-review". */
  readonly where: ReactNode;
  readonly onApprove?: () => void;
  readonly onAlwaysAllow?: () => void;
  readonly onDeny?: () => void;
}

/**
 * A Needs You approval (artboard 1's hover card; the inbox card uses it too): who is asking,
 * the command in a well, where it runs, and Approve / Always here / Deny.
 */
export function ApprovalCard({
  harness,
  title,
  summary,
  command,
  where,
  onApprove,
  onAlwaysAllow,
  onDeny,
  className,
  ...props
}: ApprovalCardProps) {
  return (
    <div data-slot="approval-card" className={cn("flex flex-col", className)} {...props}>
      <div className="flex gap-3 px-3.5 pt-3.5 pb-3">
        <Tile hue={harness} size={32}>
          <PixelHandIcon size={16} className="text-needs-you" />
        </Tile>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-label text-text-strong truncate">{title}</p>
          <p className="text-caption text-text-subtle truncate">{summary}</p>
        </div>
      </div>
      <div className="px-3.5 pb-3">
        <CodeWell>{command}</CodeWell>
      </div>
      <p className="text-caption text-text-subtle truncate px-3.5 pb-3">{where}</p>
      <div className="border-hairline flex items-center gap-1.5 border-t px-3.5 py-2.5">
        <Button variant="primary" onClick={onApprove}>
          Approve
          <Kbd variant="plain">↵</Kbd>
        </Button>
        {onAlwaysAllow === undefined ? null : (
          <Button variant="secondary" className="px-2.5" onClick={onAlwaysAllow}>
            Always here
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="ghost" className="px-2.5" onClick={onDeny}>
          Deny
        </Button>
      </div>
    </div>
  );
}
