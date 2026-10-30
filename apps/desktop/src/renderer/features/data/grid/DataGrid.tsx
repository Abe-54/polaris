/**
 * The data grid (DESIGN.md, Data: Table tab; Paper D1): typed headers over virtualised rows
 * and columns, density rows (32px in Calm), row selection, a cell inspector. The Table tab and
 * the SQL tab's results both use it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@polaris/ui";
import { memo, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { CellInspector } from "./CellInspector.tsx";
import { type GridColumn, type LaidColumn, typeLabel } from "./columns.ts";
import { GridCell } from "./GridCell.tsx";
import { useLaidColumns } from "./layout.ts";
import {
  type CellAt,
  type GridSelection,
  type Move,
  moveActive,
  selectAll,
  selectCell,
} from "./selection.ts";
import { type DataRow, type DataValue } from "./value.ts";

/** Row heights per density step: `--spacing-row` (DESIGN.md, Density). */
export const GRID_ROW = { calm: 32, balanced: 28, compact: 24 } as const;

const HEADER = 44;

/** Until the grid is measured: enough rows and columns for a first paint without a blank frame. */
const FIRST_RECT = { width: 1200, height: 800 };

export interface DataGridProps {
  readonly columns: ReadonlyArray<GridColumn>;
  readonly rows: ReadonlyArray<DataRow>;
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onForeignKey?: (column: GridColumn, value: DataValue | undefined) => void;
  /** Phase 2: whether a cell holds a staged edit. */
  readonly isStaged?: (row: number, col: number) => boolean;
  /** ⌘C with rows selected. */
  readonly onCopy?: () => void;
  readonly label: string;
  /** Shown under the header when there are no rows. */
  readonly empty?: ReactNode;
  /** Scrolled within a hundred rows of the end: time for the next page. */
  readonly onNearEnd?: () => void;
}

const NEAR_END = 100;

const gutterWidth = (rows: number) => Math.max(44, String(rows).length * 7.2 + 20);

interface RowProps {
  readonly index: number;
  readonly row: DataRow;
  readonly columns: ReadonlyArray<LaidColumn>;
  readonly first: number;
  readonly last: number;
  readonly offset: number;
  readonly start: number;
  readonly height: number;
  readonly gutter: number;
  readonly selected: boolean;
  readonly activeCol: number | null;
  readonly isStaged: DataGridProps["isStaged"];
  readonly onForeignKey: DataGridProps["onForeignKey"];
}

const GridRow = memo(function GridRow(props: RowProps) {
  const { index, row, columns, first, last, offset, start, height, gutter, selected } = props;
  const cells = [];

  for (let col = first; col <= last; col++) {
    const column = columns[col];

    if (column === undefined) continue;
    cells.push(
      <GridCell
        key={col}
        column={column}
        value={row[col]}
        row={index}
        col={col}
        active={props.activeCol === col}
        staged={props.isStaged?.(index, col) ?? false}
        onForeignKey={props.onForeignKey}
      />
    );
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-testid="data-grid-row"
      className={cn(
        "border-hairline text-code-inline absolute top-0 left-0 flex w-full border-b font-mono",
        selected ? "bg-starlight/8" : "hover:bg-fill-hover"
      )}
      style={{ height, transform: `translateY(${start}px)` }}
    >
      <div
        className="text-text-faint tabular sticky left-0 z-[1] flex h-full shrink-0 items-center justify-end bg-inherit px-2.5"
        style={{ width: gutter }}
      >
        {index + 1}
      </div>
      <div className="shrink-0" style={{ width: offset }} />
      {cells}
    </div>
  );
});

const HeaderCell = ({ column }: { readonly column: LaidColumn }) => (
  <div
    role="columnheader"
    className={cn(
      "flex shrink-0 flex-col justify-center gap-0.5 overflow-hidden px-2.5 font-mono",
      column.numeric && "items-end"
    )}
    style={{ width: column.width }}
    title={`${column.name} · ${typeLabel(column)}`}
  >
    <span className="text-code-inline text-text-strong max-w-full truncate font-medium">
      {column.name}
    </span>
    <span className="text-text-subtle max-w-full truncate text-[11px] leading-[14px]">
      {typeLabel(column)}
    </span>
  </div>
);

const MOVES = new Map<string, Move>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["Home", "home"],
  ["End", "end"],
]);

export const DataGrid = ({
  columns,
  rows,
  selection,
  onSelectionChange,
  onForeignKey,
  isStaged,
  onCopy,
  label,
  empty,
  onNearEnd,
}: DataGridProps) => {
  const scroller = useRef<HTMLDivElement>(null);
  const density = useApp((s) => s.density);
  const height = GRID_ROW[density];
  const laid = useLaidColumns(columns, rows);
  const gutter = gutterWidth(rows.length);
  const [inspect, setInspect] = useState<CellAt | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    overscan: 12,
    paddingStart: HEADER,
    initialRect: FIRST_RECT,
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: laid.length,
    getScrollElement: () => scroller.current,
    estimateSize: (at) => laid[at]?.width ?? 120,
    overscan: 3,
    initialRect: FIRST_RECT,
  });

  const virtualCols = colVirtualizer.getVirtualItems();
  const first = virtualCols[0]?.index ?? 0;
  const last = virtualCols.at(-1)?.index ?? -1;
  const offset = virtualCols[0]?.start ?? 0;
  const width = gutter + colVirtualizer.getTotalSize();
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastRow = virtualRows.at(-1)?.index ?? -1;
  const nearEnd = rows.length > 0 && lastRow >= rows.length - NEAR_END;

  useEffect(() => {
    if (nearEnd) onNearEnd?.();
  }, [nearEnd, rows.length, onNearEnd]);

  const focus = (next: GridSelection) => {
    onSelectionChange(next);

    if (next.active === null) return;
    rowVirtualizer.scrollToIndex(next.active.row);
    colVirtualizer.scrollToIndex(next.active.col);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES.get(event.key);
    const command = event.metaKey || event.ctrlKey;

    if (move !== undefined) {
      event.preventDefault();
      const far = command && (move === "up" || move === "down");

      focus(
        moveActive(
          selection,
          far ? (move === "up" ? "home" : "end") : move,
          { rows: rows.length, cols: laid.length },
          { range: event.shiftKey }
        )
      );
    } else if (command && event.key === "a") {
      event.preventDefault();
      onSelectionChange(selectAll(selection, rows.length));
    } else if (command && event.key === "c" && onCopy !== undefined) {
      event.preventDefault();
      onCopy();
    } else if ((event.key === "Enter" || event.key === " ") && selection.active !== null) {
      event.preventDefault();
      setInspect(selection.active);
    } else if (event.key === "Escape" && inspect !== null) {
      setInspect(null);
    }
  };

  const cellAt = (target: EventTarget): CellAt | null => {
    // SAFETY: grid events come from elements inside the grid's DOM.
    const cell = (target as Element).closest<HTMLElement>("[data-row][data-col]");

    return cell === null
      ? null
      : { row: Number(cell.dataset["row"]), col: Number(cell.dataset["col"]) };
  };

  const inspected = inspect === null ? undefined : laid[inspect.col];

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        role="grid"
        aria-label={label}
        aria-rowcount={rows.length + 1}
        aria-colcount={laid.length + 1}
        aria-multiselectable
        tabIndex={0}
        data-testid="data-grid"
        onKeyDown={onKeyDown}
        onMouseDown={(event) => {
          const at = cellAt(event.target);

          if (at === null || event.button !== 0) return;
          onSelectionChange(
            selectCell(selection, at, {
              range: event.shiftKey,
              toggle: event.metaKey || event.ctrlKey,
            })
          );
        }}
        onDoubleClick={(event) => setInspect(cellAt(event.target))}
        className="focus-visible:outline-starlight relative min-h-0 flex-1 overflow-auto overscroll-contain [contain:strict] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <div className="relative" style={{ width, height: rowVirtualizer.getTotalSize() }}>
          <div
            role="row"
            className="border-hairline bg-well sticky top-0 z-[2] flex border-b"
            style={{ height: HEADER, width }}
          >
            <div className="bg-well sticky left-0 z-[1] shrink-0" style={{ width: gutter }} />
            <div className="shrink-0" style={{ width: offset }} />
            {virtualCols.map((c) => {
              const column = laid[c.index];

              return column === undefined ? null : <HeaderCell key={c.index} column={column} />;
            })}
          </div>
          {virtualRows.map((r) => {
            const row = rows[r.index];

            return row === undefined ? null : (
              <GridRow
                key={r.index}
                index={r.index}
                row={row}
                columns={laid}
                first={first}
                last={last}
                offset={offset}
                start={r.start}
                height={height}
                gutter={gutter}
                selected={selection.rows.has(r.index)}
                activeCol={selection.active?.row === r.index ? selection.active.col : null}
                isStaged={isStaged}
                onForeignKey={onForeignKey}
              />
            );
          })}
        </div>
        {rows.length === 0 && empty !== undefined ? (
          <div className="absolute inset-x-0 top-[44px] bottom-0 grid place-items-center">
            {empty}
          </div>
        ) : null}
      </div>
      {inspect !== null && inspected !== undefined ? (
        <CellInspector
          column={inspected}
          value={rows[inspect.row]?.[inspect.col]}
          row={inspect.row}
          onClose={() => {
            setInspect(null);
            scroller.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
};
