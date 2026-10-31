/**
 * The status bar along the panel's foot, as the Editor's (Paper D1): the Host (its latency when
 * remote, or Reconnecting / Offline) and the checkout's branch.
 */
import { BranchIcon } from "@polaris/ui";
import { useApp } from "../../../shell/hooks.ts";
import type { DataSlotProps } from "./slots.ts";
import { useBranch } from "./useBranch.ts";

const STATES = { reconnecting: "Reconnecting", offline: "Offline" } as const;

export const DataStatusBar = ({ at, hostKey }: DataSlotProps) => {
  const host = useApp((s) => s.hosts.find((h) => h.key === hostKey));
  const branch = useBranch(at);
  const state = host?.status.state;
  const latency = host?.status.latencyMs ?? null;

  const note =
    state === "reconnecting" || state === "offline"
      ? STATES[state]
      : host?.kind !== "local" && latency !== null
        ? `${Math.round(latency)} ms`
        : null;

  return (
    <div
      className="border-hairline text-caption text-text-subtle h-tree-row px-panel gap-panel flex shrink-0 items-center border-t"
      data-testid="data-status"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="bg-text-subtle size-1.5 shrink-0 rounded-full" />
        {host?.label}
        {note === null ? null : <span>· {note}</span>}
      </span>
      {branch === null ? null : (
        <span className="flex min-w-0 items-center gap-1.5" title={branch}>
          <BranchIcon size={12} className="shrink-0" />
          <span className="min-w-0 truncate">{branch}</span>
        </span>
      )}
    </div>
  );
};
