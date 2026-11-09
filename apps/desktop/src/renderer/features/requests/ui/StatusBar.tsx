/** The status bar along the panel's foot, as Traces': the Host, then the checkout's branch. */
import { BranchIcon } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import type { RequestsSlotProps } from "./slots.ts";

export const RequestsStatusBar = ({ at }: RequestsSlotProps) => {
  const label = useApp((s) => s.hosts.find((h) => h.key === at.hostKey)?.label);

  const branch = useApp((s) => {
    const model = s.hostModels[at.hostKey];
    const worktree = model?.sessions.get(at.sessionId)?.session.worktreeId;

    return worktree === undefined || worktree === null
      ? null
      : (model?.worktrees.get(worktree)?.branch ?? null);
  });

  return (
    <div
      className="border-hairline text-caption text-text-subtle flex h-7 shrink-0 items-center gap-2 border-t px-4"
      data-testid="requests-status"
    >
      <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" />
      <span className="shrink-0">{label}</span>
      {branch === null ? null : (
        <span className="flex min-w-0 items-center gap-1">
          <BranchIcon size={12} className="shrink-0" />
          <span className="min-w-0 truncate font-mono">{branch}</span>
        </span>
      )}
      <span className="ml-auto min-w-0 truncate">
        {label === undefined ? null : `Sends from ${label}`}
      </span>
    </div>
  );
};
