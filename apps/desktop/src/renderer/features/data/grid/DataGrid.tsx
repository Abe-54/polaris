/**
 * The data grid (DESIGN.md, Data: Table tab; Paper D1): typed headers over virtualised rows
 * and columns, density rows (32px in Calm), row selection, a cell inspector. The Table tab and
 * the SQL tab's results both use it.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@polaris/ui";
import { Predicate } from "effect";
import { memo, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useApp } from "../../../shell/hooks.ts";
import { CellEditor } from "./CellEditor.tsx";
import { CellInspector } from "./CellInspector.tsx";
import { type GridColumn, type LaidColumn, typeLabel } from "./columns.ts";
import type { Editable } from "./editors.ts";
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

const COLUMN_BLOCK = 4;

/** Until the grid is measured: enough rows and columns for a first paint without a blank frame. */
const FIRST_RECT = { width: 1200, height: 800 };

export interface DataGridProps {
  readonly columns: ReadonlyArray<GridColumn>;
  readonly rows: ReadonlyArray<DataRow>;
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onForeignKey?: (column: GridColumn, value: DataValue | undefined) => void;
  /** Whether a cell holds a staged edit, or one the last commit refused as a conflict. */
  readonly isStaged?: (row: number, col: number) => boolean | "conflict";
  /** Cells edit in place (↵, F2, double-click or typing); without it ↵ inspects. */
  readonly editing?: GridEditing;
  /** ⌘C with rows selected. */
  readonly onCopy?: () => void;
  readonly label: string;
  /** Shown under the header when there are no rows. */
  readonly empty?: ReactNode;
  /** Scrolled within a hundred rows of the end: time for the next page. */
  readonly onNearEnd?: () => void;
}

export interface GridEditing {
  /** How the cell edits, or why it can't (shown in the inspector ↵ opens instead). */
  readonly editorAt: (at: CellAt) => Editable | string;
  readonly onStage: (at: CellAt, value: DataValue) => void;
  /** ⌘Z: takes back the last staged edit. */
  readonly onUndo: () => void;
  /** ⌘S inside an open editor, after it stages its draft. */
  readonly onCommit?: () => void;
}

interface Editing {
  readonly at: CellAt;
  readonly editable: Editable;
  readonly typed: string | null;
}

/**
 * A printable key typed on a cell starts its edit over with that character (⌥ characters too);
 * an IME's first keystroke starts it empty, so the composition continues in the field.
 */
const typedKey = (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.key === "Process" || event.keyCode === 229) return "";

  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && event.key !== " "
    ? event.key
    : null;
};

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
}

const ROW_CLASS =
  "border-hairline text-code-inline absolute top-0 left-0 flex w-full border-b font-mono select-none [contain:strict] [font-kerning:none] [text-rendering:optimizeSpeed]";

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
        col={col}
        active={props.activeCol === col}
        staged={props.isStaged?.(index, col) ?? false}
        height={props.height}
      />
    );
  }

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-row={index}
      data-testid="data-grid-row"
      className={selected ? `${ROW_CLASS} bg-starlight/8` : `${ROW_CLASS} hover:bg-fill-hover`}
      style={{ height, transform: `translateY(${start}px)` }}
    >
      <div className="shrink-0" style={{ width: gutter + offset }} />
      {cells}
    </div>
  );
});

/**
 * The row numbers: one sticky column over every row, not a sticky cell per row, which made each
 * row a composited layer with tiles of its own (UF2: 55 layers, 70 MB of GPU memory).
 */
const Gutter = (props: {
  readonly rows: ReadonlyArray<{ readonly index: number; readonly start: number }>;
  readonly height: number;
  readonly total: number;
  readonly width: number;
  readonly selected: ReadonlySet<number>;
  readonly slots: number;
}) => (
  <div
    aria-hidden
    className="border-hairline bg-panel text-code-inline text-text-faint tabular sticky left-0 z-[1] border-r font-mono select-none"
    style={{ width: props.width, height: props.total - HEADER }}
  >
    {props.rows.map((r) => (
      <div
        key={r.index % props.slots}
        className={cn(
          "absolute top-0 left-0 flex w-full items-center justify-end px-2.5",
          props.selected.has(r.index) && "bg-starlight/8"
        )}
        style={{ height: props.height, transform: `translateY(${r.start - HEADER}px)` }}
      >
        {r.index + 1}
      </div>
    ))}
  </div>
);

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
  editing,
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
  const [inspect, setInspect] = useState<{ at: CellAt; note: string | null } | null>(null);
  const [edit, setEdit] = useState<Editing | null>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => height,
    overscan: 1,
    // Render on the next frame, not inside the scroll event: one layout a frame, never forced.
    useFlushSync: false,
    paddingStart: HEADER,
    initialRect: FIRST_RECT,
  });

  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: laid.length,
    getScrollElement: () => scroller.current,
    estimateSize: (at) => laid[at]?.width ?? 120,
    overscan: 1,
    initialRect: FIRST_RECT,
  });

  const virtualCols = colVirtualizer.getVirtualItems();
  // Whole blocks of columns, so a horizontal scroll re-renders rows only when it crosses one.
  const first = Math.floor((virtualCols[0]?.index ?? 0) / COLUMN_BLOCK) * COLUMN_BLOCK;

  const last = Math.min(
    laid.length - 1,
    (Math.floor((virtualCols.at(-1)?.index ?? -1) / COLUMN_BLOCK) + 1) * COLUMN_BLOCK - 1
  );

  const offset = colVirtualizer.measurementsCache[first]?.start ?? 0;
  const width = gutter + colVirtualizer.getTotalSize();
  const virtualRows = rowVirtualizer.getVirtualItems();
  // Rows render in slot order (index modulo a count that only grows), so a scroll changes their
  // props but never their DOM order: a moved row is re-attached, restyled and laid out whole.
  const slots = useRef(0);

  slots.current = Math.max(slots.current, virtualRows.length);

  const bySlot = virtualRows.toSorted(
    (a, b) => (a.index % slots.current) - (b.index % slots.current)
  );

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

  const follow = (at: CellAt) => {
    const column = laid[at.col];

    if (column?.fk != null) onForeignKey?.(column, rows[at.row]?.[at.col]);
  };

  const arrow = (move: Move, event: KeyboardEvent<HTMLDivElement>) => {
    const far = (event.metaKey || event.ctrlKey) && (move === "up" || move === "down");
    const to = far ? (move === "up" ? "home" : "end") : move;

    focus(
      moveActive(selection, to, { rows: rows.length, cols: laid.length }, { range: event.shiftKey })
    );
  };

  /** ⌘A, ⌘C and ⌘↵ (follow a foreign key); true when the key was one of them. */
  const chord = (key: string) => {
    if (key === "a") onSelectionChange(selectAll(selection, rows.length));
    else if (key === "c" && onCopy !== undefined) onCopy();
    else if (key === "Enter" && selection.active !== null) follow(selection.active);
    else if (key === "z" && editing !== undefined) editing.onUndo();
    else return false;

    return true;
  };

  /** ↵, F2, a double-click or a typed key: the cell's editor, else the inspector with why not. */
  const open = (at: CellAt, typed: string | null = null) => {
    const how = editing?.editorAt(at);

    if (how === undefined || Predicate.isString(how)) {
      if (typed === null) setInspect({ at, note: how ?? null });

      return;
    }

    if (typed !== null && how.kind === "bool") return;
    setInspect(null);
    setEdit({ at, editable: how, typed });
  };

  const closeEdit = () => {
    setEdit(null);
    scroller.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const move = MOVES.get(event.key);
    const active = selection.active;
    const typed = editing === undefined ? null : typedKey(event);

    if (move !== undefined) {
      event.preventDefault();
      arrow(move, event);
    } else if ((event.metaKey || event.ctrlKey) && chord(event.key)) {
      event.preventDefault();
    } else if ((event.key === "Enter" || event.key === "F2") && active !== null) {
      event.preventDefault();
      open(active);
    } else if (event.key === " " && active !== null) {
      event.preventDefault();
      setInspect({ at: active, note: null });
    } else if (typed !== null && active !== null) {
      event.preventDefault();
      open(active, typed);
    } else if (event.key === "Escape") {
      setInspect(null);
    }
  };

  const cellAt = (target: EventTarget): CellAt | null => {
    // SAFETY: grid events come from elements inside the grid's DOM.
    const cell = (target as Element).closest<HTMLElement>("[data-col]");
    const row = cell?.closest<HTMLElement>("[data-row]");

    return cell == null || row == null
      ? null
      : { row: Number(row.dataset["row"]), col: Number(cell.dataset["col"]) };
  };

  const inspected = inspect === null ? undefined : laid[inspect.at.col];
  const edited = edit === null ? undefined : laid[edit.at.col];

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
        onClick={(event) => {
          const at = cellAt(event.target);

          if (at !== null && event.target instanceof HTMLElement && event.target.dataset["fk"])
            follow(at);
        }}
        onDoubleClick={(event) => {
          const at = cellAt(event.target);

          if (at !== null) open(at);
        }}
        className="focus-visible:outline-starlight relative min-h-0 flex-1 overflow-auto overscroll-contain [contain:strict] outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      >
        <div
          className="relative min-w-full"
          style={{ width, height: rowVirtualizer.getTotalSize() }}
        >
          <div
            role="row"
            className="border-hairline bg-well sticky top-0 z-[2] flex min-w-full border-b"
            style={{ height: HEADER, width }}
          >
            <div className="bg-well sticky left-0 z-[1] shrink-0" style={{ width: gutter }} />
            <div className="shrink-0" style={{ width: offset }} />
            {laid.slice(first, last + 1).map((column, i) => (
              <HeaderCell key={first + i} column={column} />
            ))}
          </div>
          <Gutter
            rows={bySlot}
            height={height}
            total={rowVirtualizer.getTotalSize()}
            width={gutter}
            selected={selection.rows}
            slots={slots.current}
          />
          {bySlot.map((r) => {
            const row = rows[r.index];

            return row === undefined ? null : (
              <GridRow
                // A slot, not the row: a jump reuses each row's elements rather than remounting.
                key={r.index % slots.current}
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
              />
            );
          })}
        </div>
        {edit !== null && edited !== undefined && editing !== undefined ? (
          <CellEditor
            key={`${edit.at.row}:${edit.at.col}`}
            column={edited}
            editable={edit.editable}
            value={rows[edit.at.row]?.[edit.at.col] ?? null}
            typed={edit.typed}
            top={rowVirtualizer.measurementsCache[edit.at.row]?.start ?? HEADER}
            left={gutter + (colVirtualizer.measurementsCache[edit.at.col]?.start ?? 0)}
            height={height}
            onStage={(value) => {
              editing.onStage(edit.at, value);
              closeEdit();
            }}
            onCancel={closeEdit}
            onCommit={editing.onCommit}
          />
        ) : null}
        {rows.length === 0 && empty !== undefined ? (
          <div className="absolute inset-x-0 top-[44px] bottom-0 grid place-items-center">
            {empty}
          </div>
        ) : null}
      </div>
      {inspect !== null && inspected !== undefined ? (
        <CellInspector
          column={inspected}
          value={rows[inspect.at.row]?.[inspect.at.col]}
          row={inspect.at.row}
          note={inspect.note}
          onClose={() => {
            setInspect(null);
            scroller.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
};
