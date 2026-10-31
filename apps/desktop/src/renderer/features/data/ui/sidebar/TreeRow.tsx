/**
 * One Sources row (Paper D1): a Data Source with its label dot and lock, a schema, a table with
 * its row estimate or git letter, the functions group, or a note under a source.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  cn,
  Dither,
  GIT_LETTERS,
  GIT_TINTS,
  GridIcon,
  LockIcon,
} from "@polaris/ui";
import type { ReactNode } from "react";
import { formatEstimate, isLocked, LABEL_TONES } from "../../model/source.ts";
import type { TreeRow as Row } from "../../model/tree.ts";

const ROW =
  "h-tree-row flex w-full cursor-default items-center gap-2 rounded-[8px] pr-2.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-starlight focus-visible:ring-inset";

const Chevron = ({ open, shown }: { readonly open: boolean; readonly shown: boolean }) => (
  <span className="text-text-subtle flex w-3 shrink-0 justify-center">
    {shown ? open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} /> : null}
  </span>
);

/** The trailing 44px lane: the git letter where an agent changed the table, else its estimate. */
const Lane = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span
    className={cn(
      "text-micro tabular w-11 shrink-0 text-right font-mono whitespace-nowrap",
      className
    )}
  >
    {children}
  </span>
);

export interface TreeRowProps {
  readonly row: Row;
  readonly selected: boolean;
  /** The Harness kind of an agent querying this table now. */
  readonly busy: string | null;
  readonly onToggle: (key: string, open: boolean) => void;
  readonly onOpenTable: (source: string, table: string) => void;
}

const SourceRow = ({
  row,
  onToggle,
}: {
  row: Extract<Row, { kind: "source" }>;
  onToggle: TreeRowProps["onToggle"];
}) => {
  const { source } = row;
  const tone = LABEL_TONES[source.label.colour];

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={1}
      aria-expanded={row.expandable ? row.open : undefined}
      data-testid="data-source-row"
      data-source={source.name}
      onClick={() => row.expandable && onToggle(row.key, row.open)}
      className={cn(ROW, "pl-2", row.expandable && "hover:bg-fill-hover")}
      title={`${source.name} · ${source.engine} · ${source.locality}`}
    >
      <Chevron open={row.open} shown={row.expandable} />
      {tone.fill === "" ? null : (
        <span
          className={cn("size-1.5 shrink-0 rounded-full", tone.fill)}
          data-testid="data-source-dot"
        />
      )}
      <span
        className={cn(
          "text-label min-w-[6ch] flex-auto truncate font-medium",
          source.reachable === false ? "text-text-subtle" : "text-text-strong"
        )}
      >
        {source.name}
      </span>
      <span className="text-micro text-text-subtle min-w-0 shrink-[20] truncate font-mono">
        {source.engine} · {source.locality}
      </span>
      {!isLocked(source) ? null : (
        <LockIcon size={12} className="text-text-subtle shrink-0" aria-label="Not approved" />
      )}
    </button>
  );
};

const TableRow = ({
  row,
  selected,
  busy,
  onOpenTable,
}: {
  row: Extract<Row, { kind: "table" }>;
  selected: boolean;
  busy: string | null;
  onOpenTable: TreeRowProps["onOpenTable"];
}) => {
  const { summary, change } = row;
  const git = change === null ? null : GIT_TINTS[change];

  return (
    <button
      type="button"
      role="treeitem"
      aria-level={3}
      aria-selected={selected}
      data-testid="data-table-row"
      data-table={row.table}
      onClick={() => onOpenTable(row.source, row.table)}
      className={cn(ROW, "pl-10", selected ? "bg-fill-selected" : "hover:bg-fill-hover")}
      title={`${row.table}${summary.rowEstimate === null ? "" : ` · about ${summary.rowEstimate} rows`}${row.view ? " · view" : ""}`}
    >
      <GridIcon
        size={12}
        className={cn(
          "shrink-0",
          selected ? "text-text-default" : "text-text-faint",
          row.view && "opacity-(--opacity-dimmed)"
        )}
      />
      <span
        className={cn(
          "text-label min-w-0 flex-1 truncate",
          selected ? "text-text-strong font-medium" : (git ?? "text-text-default")
        )}
      >
        {summary.name}
      </span>
      {busy === null ? null : (
        <Dither hue={busy} size={12} moving aria-label="An agent is querying this table" />
      )}
      {change === null ? (
        <Lane className="text-text-subtle">
          {row.view ? "view" : formatEstimate(summary.rowEstimate)}
        </Lane>
      ) : (
        <Lane className={cn("font-medium", git)}>
          <span title={change}>{GIT_LETTERS[change]}</span>
        </Lane>
      )}
    </button>
  );
};

export const TreeRow = ({ row, selected, busy, onToggle, onOpenTable }: TreeRowProps) => {
  switch (row.kind) {
    case "source":
      return <SourceRow row={row} onToggle={onToggle} />;
    case "table":
      return <TableRow row={row} selected={selected} busy={busy} onOpenTable={onOpenTable} />;
    case "note":
      return (
        <p className="text-caption text-text-subtle py-1 pr-2.5 pl-7" data-testid="data-tree-note">
          {row.text}
        </p>
      );
    case "function":
      return (
        <div
          className={cn(ROW, "text-caption text-text-subtle pl-[60px] font-mono")}
          role="treeitem"
          aria-level={4}
        >
          <span className="min-w-0 truncate" title={row.name}>
            {row.name}
          </span>
        </div>
      );
    default:
      return (
        <button
          type="button"
          role="treeitem"
          aria-level={row.kind === "schema" ? 2 : 3}
          aria-expanded={row.open}
          onClick={() => onToggle(row.key, row.open)}
          className={cn(ROW, "hover:bg-fill-hover", row.kind === "schema" ? "pl-[22px]" : "pl-10")}
        >
          {row.kind === "schema" ? (
            <Chevron open={row.open} shown />
          ) : (
            <span className="text-caption text-text-faint w-3 shrink-0 text-center font-mono italic">
              ƒ
            </span>
          )}
          <span
            className={cn(
              "text-label min-w-0 flex-1 truncate",
              row.kind === "schema" ? "text-text-default" : "text-text-subtle"
            )}
          >
            {row.kind === "schema" ? row.name : "functions"}
          </span>
          <Lane className="text-text-subtle">{row.count}</Lane>
        </button>
      );
  }
};
