/**
 * The cell inspector: a clipped value whole, in an instrument card over the grid's right edge
 * (↵ or a double-click opens it, esc closes). JSON is indented; past 64 KB only the start shows.
 */
import { CopyButton, IconButton, CloseIcon } from "@polaris/ui";
import { useMemo } from "react";
import type { LaidColumn } from "./columns.ts";
import { type Cell, cellOf, type DataValue } from "./value.ts";

/** The most the inspector draws; Copy value still takes it all. */
export const INSPECT_CHARS = 64 * 1024;

const size = (chars: number) =>
  chars < 1024
    ? `${chars} B`
    : chars < 1024 * 1024
      ? `${(chars / 1024).toFixed(1)} KB`
      : `${(chars / 1024 / 1024).toFixed(1)} MB`;

const pretty = (cell: Cell): string => {
  if (cell.raw === null) return "NULL";

  if (cell.kind !== "json" || cell.raw.length > 4 * INSPECT_CHARS) return cell.raw;

  try {
    return JSON.stringify(JSON.parse(cell.raw), null, 2);
  } catch {
    return cell.raw;
  }
};

const status = (cell: Cell, shown: number) => {
  const length = cell.raw?.length ?? 0;
  const parts = [cell.raw === null ? "null" : size(length)];

  if (cell.bytes !== undefined) parts.push(`${size(cell.bytes)} in the database`);

  if (shown < length) parts.push(`first ${size(shown)} shown`);

  return parts.join(" · ");
};

export const CellInspector = ({
  column,
  value,
  row,
  onClose,
}: {
  readonly column: LaidColumn;
  readonly value: DataValue | undefined;
  readonly row: number;
  readonly onClose: () => void;
}) => {
  const cell = cellOf(value);
  const text = useMemo(() => pretty(cell), [cell.raw, cell.kind]);
  const shown = text.slice(0, INSPECT_CHARS);

  return (
    <div
      role="dialog"
      aria-label={`${column.name}, row ${row + 1}`}
      data-testid="data-cell-inspector"
      data-surface="raised"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="rounded-card border-hairline bg-raised shadow-float absolute top-2 right-2 bottom-2 z-20 flex w-[min(440px,calc(100%-16px))] flex-col overflow-hidden border"
    >
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3">
        <span className="text-label text-text-strong min-w-0 truncate font-mono">
          {column.name}
        </span>
        <span className="text-text-subtle tabular min-w-0 flex-1 truncate font-mono text-[11px] leading-[14px]">
          {column.type} · row {row + 1}
        </span>
        <IconButton
          size="sm"
          label="Close"
          shortcut="esc"
          icon={<CloseIcon size={16} />}
          onClick={onClose}
        />
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-2 pt-2 pb-2">
        <pre
          tabIndex={0}
          className="border-hairline bg-well text-code-inline min-h-0 flex-1 overflow-auto rounded-[12px] border p-3 font-mono break-all whitespace-pre-wrap"
        >
          <span className={cell.raw === null ? "text-text-faint" : "text-text-default"}>
            {shown}
          </span>
        </pre>
      </div>
      <footer className="border-hairline flex min-h-9 shrink-0 items-center gap-2 border-t px-4 py-1.5">
        <span className="text-text-subtle min-w-0 flex-1 truncate font-mono text-[11px] leading-[14px] tracking-[0.06em] uppercase">
          {status(cell, shown.length < text.length ? shown.length : text.length)}
        </span>
        {cell.raw === null ? null : (
          <CopyButton text={cell.raw} label="Copy value" variant="button" buttonSize="sm" />
        )}
      </footer>
    </div>
  );
};
