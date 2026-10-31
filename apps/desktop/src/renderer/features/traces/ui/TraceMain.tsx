/**
 * Placeholder: the waterfall and Table with their toolbar, minimap and ruler (DESIGN.md, Traces →
 * Waterfall) replace this file. Until then it says whether there is a trace to show.
 */
import { EmptyState, PixelHourglassIcon } from "@polaris/ui";
import { useTraces } from "../data/hooks.tsx";
import type { TracesSlotProps } from "./slots.ts";

export const TraceMain = ({ at, traceId }: TracesSlotProps) => {
  const snapshot = useTraces(at);
  const none = snapshot.status === "ready" && snapshot.value.total === 0;

  return (
    <div className="grid min-h-0 flex-1 place-items-center" data-testid="traces-main">
      {traceId === null && (
        <EmptyState
          icon={<PixelHourglassIcon size={24} className="text-text-strong" />}
          title={none ? "No traces yet" : "No trace open"}
          fact={
            none
              ? "Code run in this agent session's checkout sends its traces here"
              : "Choose a trace in the sidebar"
          }
        />
      )}
    </div>
  );
};
