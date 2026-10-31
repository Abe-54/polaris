/**
 * Placeholder: the `Traces | Profiles` switch, the filter well, traces under Turn kickers and
 * "Agents in this worktree" (DESIGN.md, Traces → Sidebar) replace this file.
 */
import { useApp } from "../../../shell/hooks.ts";
import { useTraces } from "../data/hooks.tsx";
import { selectTrace } from "../model/store.ts";
import type { TracesSlotProps } from "./slots.ts";

export const TracesSidebar = ({ at, hostKey, workspaceId, traceId }: TracesSlotProps) => {
  const workspace = useApp((s) => s.hostModels[hostKey]?.workspaces.get(workspaceId));
  const snapshot = useTraces(at);
  const traces = snapshot.status === "ready" ? snapshot.value.traces : [];

  return (
    <aside
      aria-label="Traces"
      data-testid="traces-sidebar"
      className="flex min-h-0 w-[270px] flex-1 flex-col"
    >
      <div className="px-panel pt-panel flex min-h-0 flex-col gap-3">
        <h1 className="text-heading text-text-strong min-w-0 truncate">{workspace?.name ?? ""}</h1>
        <p className="text-micro text-text-subtle font-mono tracking-wide uppercase">
          Traces · {snapshot.status === "ready" ? snapshot.value.total : 0}
        </p>
        <ul className="flex min-h-0 flex-col overflow-auto">
          {traces.map((trace) => (
            <li key={trace.id}>
              <button
                type="button"
                aria-pressed={trace.id === traceId}
                onClick={() => selectTrace(at, trace.id)}
                className="text-code-inline aria-pressed:bg-row-selected rounded-row flex h-7 w-full cursor-default items-center justify-between gap-2 px-2 font-mono"
              >
                <span className="text-text-default truncate">{trace.root}</span>
                <span className="text-text-subtle tabular shrink-0">
                  {Math.round(trace.durationMs)} ms
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
};
