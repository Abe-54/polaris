/**
 * The files list's Data section (Paper D4): the "Data · app" kicker, its Schema diff row with
 * table counts, then rows changed per table; each opens the Schema Diff in the diff pane.
 */
import { cn, KICKER } from "@polaris/ui";
import type { DataListRow, TableKind } from "./model.ts";

const COUNT_TEXT: Record<TableKind, string> = {
  added: "text-diff-added-text",
  removed: "text-diff-removed-text",
  changed: "text-git-modified-text",
  renamed: "text-git-modified-text",
};

const STATUS_WORDS = { pending: "capturing…", unavailable: "unavailable", complete: null };

const ROW =
  "rounded-row hover:bg-fill-hover h-tree-row gap-row-x px-gap flex w-full cursor-default items-center text-left";

export interface DataRowProps {
  readonly row: DataListRow;
  /** The source whose Schema Diff the pane shows; null while it shows the files. */
  readonly open: string | null;
  readonly onOpen: (sourceId: string) => void;
}

export const DataRow = ({ row, open, onOpen }: DataRowProps) => {
  if (row.kind === "data-head")
    return (
      <div
        data-testid="review-data-head"
        className={cn(KICKER, "px-gap flex h-tree-row min-w-0 items-end pb-1")}
        title={`Data · ${row.name}`}
      >
        <span className="truncate">Data · {row.name}</span>
      </div>
    );

  const current = row.kind === "data-schema" && open === row.sourceId;

  return (
    <button
      type="button"
      data-testid={`review-${row.kind}`}
      aria-current={current ? "true" : undefined}
      onClick={() => onOpen(row.sourceId)}
      className={cn(ROW, current && "bg-fill-hover")}
    >
      <span aria-hidden="true" className="size-3.5 shrink-0" />
      {row.kind === "data-schema" && (
        <>
          <span
            className={cn(
              "text-caption min-w-0 flex-1 truncate",
              current ? "text-text-strong" : "text-text-default"
            )}
          >
            Schema diff
          </span>
          {STATUS_WORDS[row.status] !== null && (
            <span className="text-caption text-text-subtle shrink-0">
              {STATUS_WORDS[row.status]}
            </span>
          )}
          {row.counts.map((count) => (
            <span
              key={count.kind}
              className={cn("text-caption tabular shrink-0 font-mono", COUNT_TEXT[count.kind])}
            >
              {count.text}
            </span>
          ))}
        </>
      )}
      {row.kind === "data-rows" && (
        <>
          <span
            className="text-caption text-text-default min-w-0 flex-1 truncate"
            title={row.table}
          >
            <span className="font-mono">{row.table}</span> rows
          </span>
          <span className="text-caption text-text-subtle tabular shrink-0 font-mono">
            {row.figure}
          </span>
        </>
      )}
      {row.kind === "data-more" && (
        <span className="text-caption text-text-subtle min-w-0 flex-1 truncate">
          + {row.count.toLocaleString("en-US")} more {row.count === 1 ? "table" : "tables"}
        </span>
      )}
    </button>
  );
};
