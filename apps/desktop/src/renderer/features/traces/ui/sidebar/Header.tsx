/** The sidebar's header, as Data's: the Workspace, then its Host and the checkout's branch. */
import { BranchIcon } from "@polaris/ui";
import { useApp } from "../../../../shell/hooks.ts";
import type { TracesSlotProps } from "../slots.ts";

const useBranch = ({ at }: TracesSlotProps): string | null =>
  useApp((s) => {
    const model = s.hostModels[at.hostKey];
    const worktree = model?.sessions.get(at.sessionId)?.session.worktreeId;

    if (worktree === undefined || worktree === null) return null;

    return model?.worktrees.get(worktree)?.branch ?? null;
  });

export const Header = (props: TracesSlotProps) => {
  const name = useApp((s) => s.hostModels[props.hostKey]?.workspaces.get(props.workspaceId)?.name);
  const host = useApp((s) => s.hosts.find((h) => h.key === props.hostKey));
  const branch = useBranch(props);
  const state = host?.status.state;
  const away = state === "reconnecting" || state === "offline";

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <h1 className="text-heading text-text-strong min-w-0 truncate" title={name}>
        {name ?? ""}
      </h1>
      <p className="text-caption text-text-subtle flex min-w-0 items-center gap-1">
        <span className="shrink-0">{host?.label}</span>
        {away ? (
          <span className="shrink-0">· {state === "offline" ? "Offline" : "Reconnecting"}</span>
        ) : null}
        {branch === null ? null : (
          <>
            <span className="shrink-0">·</span>
            <BranchIcon size={12} className="shrink-0" />
            <span className="min-w-0 truncate font-mono" title={branch}>
              {branch}
            </span>
          </>
        )}
      </p>
    </div>
  );
};
