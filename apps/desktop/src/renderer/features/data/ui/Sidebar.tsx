/**
 * Placeholder: the sidebar's `Sources | Query log` switch, the source tree and "Agents in this
 * worktree" (DESIGN.md, Data → Sidebar) replace this file.
 */
import { useApp } from "../../../shell/hooks.ts";
import { useDataSources } from "../data/hooks.tsx";
import type { DataSlotProps } from "./slots.ts";

export const DataSidebar = ({ at, hostKey, workspaceId }: DataSlotProps) => {
  const workspace = useApp((s) => s.hostModels[hostKey]?.workspaces.get(workspaceId));
  const sources = useDataSources(at);
  const list = sources.status === "ready" ? sources.value : [];

  return (
    <aside
      aria-label="Data sources"
      data-testid="data-sidebar"
      className="flex min-h-0 w-[270px] flex-1 flex-col"
    >
      <div className="px-panel pt-panel flex flex-col gap-3">
        <h1 className="text-heading text-text-strong min-w-0 truncate">{workspace?.name ?? ""}</h1>
        <p className="text-micro text-text-subtle font-mono tracking-wide uppercase">
          Data sources · {list.length}
        </p>
        <ul className="flex flex-col">
          {list.map((source) => (
            <li key={source.id} className="text-body flex h-7 items-center justify-between gap-2">
              <span className="text-text-default truncate">{source.name}</span>
              <span className="text-caption text-text-subtle font-mono">
                {source.engine} · {source.locality}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
};
