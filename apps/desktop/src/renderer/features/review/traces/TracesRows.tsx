/**
 * The files list's Traces section (DESIGN.md, Traces → In Review), beside Data's: the "Traces"
 * kicker, its Route timings row with the route count, then the first routes' p50 before →
 * after; each opens Route timings in the diff pane.
 */
import { cn, KICKER } from "@polaris/ui";
import type { TracesListRow } from "./model.ts";

const ROW =
  "rounded-row hover:bg-fill-hover h-tree-row gap-row-x px-gap flex w-full cursor-default items-center text-left";

export interface TracesRowProps {
  readonly row: TracesListRow;
  /** The diff pane shows Route timings. */
  readonly open: boolean;
  readonly onOpen: () => void;
}

export const TracesRow = ({ row, open, onOpen }: TracesRowProps) => {
  if (row.kind === "traces-head")
    return (
      <div
        data-testid="review-traces-head"
        className={cn(KICKER, "px-gap flex h-tree-row min-w-0 items-end pb-1")}
      >
        <span className="truncate">Traces</span>
      </div>
    );

  const current = row.kind === "traces-compare" && open;

  return (
    <button
      type="button"
      data-testid={`review-${row.kind}`}
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      title={row.kind === "traces-more" ? undefined : row.title}
      className={cn(ROW, current && "bg-fill-hover")}
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      {row.kind === "traces-compare" && (
        <>
          <span
            className={cn(
              "text-caption min-w-0 flex-1 truncate whitespace-nowrap",
              current ? "text-text-strong" : "text-text-default"
            )}
          >
            Route timings
          </span>
          <span className="text-caption text-text-subtle tabular shrink-0">{row.figure}</span>
        </>
      )}
      {row.kind === "traces-route" && (
        <>
          <span className="text-caption text-text-default min-w-0 flex-1 truncate font-mono">
            {row.route}
          </span>
          <span className="text-caption text-text-subtle tabular shrink-0 font-mono">
            {row.figure}
          </span>
        </>
      )}
      {row.kind === "traces-more" && (
        <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
          + {row.count.toLocaleString("en-US")} more {row.count === 1 ? "route" : "routes"}
        </span>
      )}
    </button>
  );
};
