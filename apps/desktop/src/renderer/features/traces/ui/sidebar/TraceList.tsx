/**
 * Traces under Turn kickers (DESIGN.md, Traces → Sidebar; Paper T1): 28px rows of a 12px status
 * slot, the root span in code-inline, and its duration in a fixed 40px tabular lane.
 */
import type { TraceSummary } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { type KeyboardEvent, useMemo } from "react";
import { groupByTurn, tracesLabel, turnKicker } from "../../model/sidebar.ts";
import { durationLabel } from "../../model/waterfall/time.ts";

/** A faint dot, or a critical square for a trace with an error span. */
const StatusSlot = ({ error }: { readonly error: boolean }) => (
  <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden>
    {error ? (
      <span className="bg-severity-critical size-1.5 rounded-[1px]" />
    ) : (
      <span className="bg-text-faint size-[5px] rounded-full" />
    )}
  </span>
);

const TraceRow = ({
  trace,
  open,
  onOpen,
}: {
  readonly trace: TraceSummary;
  readonly open: boolean;
  readonly onOpen: (id: string) => void;
}) => {
  const error = trace.errors > 0;

  return (
    <button
      type="button"
      data-testid="traces-row"
      data-trace={trace.id}
      aria-current={open ? "true" : undefined}
      aria-label={`${trace.root}, ${durationLabel(trace.durationMs)}${error ? ", has an error" : ""}${trace.partial ? ", partial" : ""}`}
      onClick={() => onOpen(trace.id)}
      className={cn(
        "h-tree-row hover:bg-fill-hover focus-visible:ring-starlight flex w-full shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 text-left outline-none focus-visible:ring-2",
        open && "bg-raised ring-hairline ring-1 ring-inset hover:bg-raised"
      )}
    >
      <StatusSlot error={error} />
      <span
        className={cn(
          "text-code-inline min-w-0 flex-1 truncate font-mono",
          error && "text-severity-critical-text",
          !error && (open ? "text-text-strong" : "text-text-default")
        )}
        title={trace.root}
      >
        {trace.root}
      </span>
      <span
        className={cn(
          "text-micro tabular w-10 shrink-0 text-right font-mono whitespace-nowrap",
          open ? "text-text-strong" : "text-text-subtle"
        )}
      >
        {durationLabel(trace.durationMs)}
      </span>
    </button>
  );
};

/** Up and Down move between rows and open the one reached, as a list does. */
const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-trace]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];

  if (next === undefined) return;
  event.preventDefault();
  next.focus();
  next.click();
};

export interface TraceListProps {
  readonly traces: ReadonlyArray<TraceSummary>;
  readonly openId: string | null;
  /** The session's latest Turn, whose kicker says NOW. */
  readonly latestTurn: number | null;
  readonly onOpen: (id: string) => void;
}

export const TraceList = ({ traces, openId, latestTurn, onOpen }: TraceListProps) => {
  const groups = useMemo(() => groupByTurn(traces), [traces]);

  return (
    <div
      role="list"
      aria-label="Traces by turn"
      className="flex flex-col gap-0.5"
      onKeyDown={moveFocus}
    >
      {groups.map((group) => (
        <section key={group.key} role="listitem" className="flex flex-col gap-0.5">
          <h2 className="flex h-8 shrink-0 items-center justify-between pt-2 pr-2.5 pl-2 font-mono">
            <span className="text-micro text-text-subtle font-medium tracking-[0.06em]">
              {turnKicker(group.turn, latestTurn)}
            </span>
            <span className="text-micro text-text-subtle">{tracesLabel(group.traces.length)}</span>
          </h2>
          {group.traces.map((trace) => (
            <TraceRow
              key={trace.id}
              trace={trace}
              open={openId !== null && trace.id.startsWith(openId)}
              onOpen={onOpen}
            />
          ))}
        </section>
      ))}
    </div>
  );
};
