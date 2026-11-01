/**
 * A write's dry-run rows (Paper D3): each row before (−) and after (+), its changed cells in the
 * diff colours, NULL faint. A wide table leads with the columns the write changes.
 */
import type { DataValue } from "@polaris/protocol";
import { Button, cn } from "@polaris/ui";
import { useState } from "react";
import { cellOf, displayOf, placeholderOf } from "../grid/value.ts";
import {
  type CellChange,
  cellChanges,
  type CellStandIn,
  cellStandIns,
  changedColumns,
  type DataWrite,
} from "./model.ts";

/** Columns shown before "Show all columns": the changed ones and the first few for context. */
const SHOWN_COLUMNS = 12;

const CONTEXT_COLUMNS = 2;

/** The columns shown, in table order: changed ones first in the count, then context. */
export const visibleColumns = (write: DataWrite, all: boolean): ReadonlyArray<number> => {
  const indexes = write.columns.map((_, i) => i);

  if (all || indexes.length <= SHOWN_COLUMNS) return indexes;
  const changed = changedColumns(write);

  const picked = new Set([
    ...indexes.filter((i) => changed.has(i)).slice(0, SHOWN_COLUMNS),
    ...indexes.slice(0, CONTEXT_COLUMNS),
  ]);

  for (const i of indexes) {
    if (picked.size >= SHOWN_COLUMNS) break;
    picked.add(i);
  }

  return indexes.filter((i) => picked.has(i));
};

const FILL: Record<CellChange, Record<"before" | "after", string>> = {
  same: { before: "", after: "" },
  changed: { before: "bg-diff-removed-bg", after: "bg-diff-added-bg" },
  added: { before: "", after: "bg-diff-added-bg" },
  removed: { before: "bg-diff-removed-bg", after: "" },
};

/** Title text for a long cell: enough to read, never the whole of a huge value. */
const TITLE_CHARS = 1000;

/** A credential cell's or a database-filled cell's words, in place of its value. */
const STAND_IN = {
  redacted: { text: "redacted", title: "A credential: Polaris doesn't show its value" },
  changed: { text: "redacted · changed", title: "A credential this write changes" },
  assigned: { text: "assigned on run", title: "The database fills this when the write runs" },
} as const;

const standInWords = (standIn: CellStandIn) => {
  if (standIn.kind === "assigned") return STAND_IN.assigned;

  return standIn.changed ? STAND_IN.changed : STAND_IN.redacted;
};

const StandInCell = ({
  standIn,
  change,
  side,
}: {
  readonly standIn: CellStandIn;
  readonly change: CellChange;
  readonly side: "before" | "after";
}) => {
  const words = standInWords(standIn);

  return (
    <td
      className={cn(
        "border-hairline text-text-subtle h-7 max-w-[240px] truncate border-r px-2 text-[12px] leading-7 italic",
        FILL[change][side]
      )}
      title={words.title}
      data-change={change === "same" ? undefined : change}
      data-stand-in={standIn.kind}
    >
      {side === "before" && standIn.kind === "redacted" ? STAND_IN.redacted.text : words.text}
    </td>
  );
};

const Cell = ({
  value,
  change,
  side,
  standIn,
}: {
  readonly value: DataValue | undefined;
  readonly change: CellChange;
  readonly side: "before" | "after";
  readonly standIn: CellStandIn | null;
}) => {
  if (standIn !== null) return <StandInCell standIn={standIn} change={change} side={side} />;
  const cell = cellOf(value);
  const placeholder = placeholderOf(cell);

  return (
    <td
      className={cn(
        "border-hairline h-7 max-w-[240px] truncate border-r px-2 font-mono text-[12px] leading-7",
        FILL[change][side],
        placeholder === null ? "text-text-default" : "text-text-faint italic",
        cell.kind === "number" && "tabular text-right"
      )}
      title={cell.raw?.slice(0, TITLE_CHARS) ?? "NULL"}
      data-change={change === "same" ? undefined : change}
    >
      {displayOf(cell)}
    </td>
  );
};

const SIGN = { before: "−", after: "+" } as const;

type StandIns = ReturnType<typeof cellStandIns>;

const Line = ({
  n,
  row,
  changes,
  columns,
  side,
  standIns,
}: {
  readonly n: number;
  readonly row: ReadonlyArray<DataValue>;
  readonly changes: ReadonlyArray<CellChange>;
  readonly columns: ReadonlyArray<number>;
  readonly side: "before" | "after";
  readonly standIns: StandIns;
}) => (
  <tr data-side={side}>
    <td
      className={cn(
        "border-hairline w-5 border-r text-center font-mono text-[12px]",
        side === "before" ? "text-diff-removed-text" : "text-diff-added-text"
      )}
      aria-label={side}
    >
      {SIGN[side]}
    </td>
    {columns.map((col) => (
      <Cell
        key={col}
        value={row[col]}
        change={changes[col] ?? "same"}
        side={side}
        standIn={standIns(n, col, side)}
      />
    ))}
  </tr>
);

export const BeforeAfter = ({
  write,
  className,
}: {
  readonly write: DataWrite;
  /** The rows' height cap, where the card sits (Output's is shorter). */
  readonly className?: string;
}) => {
  const [all, setAll] = useState(false);
  const columns = visibleColumns(write, all);
  const changes = cellChanges(write);
  const standIns = cellStandIns(write);
  const hidden = write.columns.length - columns.length;

  if (changes.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "border-hairline bg-surface-sunken max-h-[420px] overflow-auto rounded-[10px] border",
          className
        )}
        data-testid="data-write-rows"
      >
        <table className="w-max min-w-full border-collapse">
          <thead className="bg-surface-raised sticky top-0">
            <tr>
              <th className="border-hairline w-5 border-r border-b" />
              {columns.map((col) => (
                <th
                  key={col}
                  className="border-hairline text-caption text-text-subtle h-7 max-w-[240px] truncate border-r border-b px-2 text-left font-mono font-normal"
                  title={write.columns[col]}
                >
                  {write.columns[col]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {changes.map((rowChanges, n) => {
              const before = write.before[n];
              const after = write.after[n];

              return (
                <RowPair
                  // Preview rows are positional and never reorder.
                  key={n}
                  n={n}
                  standIns={standIns}
                  before={before}
                  after={after}
                  changes={rowChanges}
                  columns={columns}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 || all ? (
        <Button variant="ghost" size="xs" className="self-start" onClick={() => setAll(!all)}>
          {all ? "Show changed columns" : `Show all ${write.columns.length} columns`}
        </Button>
      ) : null}
    </div>
  );
};

const RowPair = ({
  n,
  standIns,
  before,
  after,
  changes,
  columns,
}: {
  readonly n: number;
  readonly standIns: StandIns;
  readonly before: ReadonlyArray<DataValue> | undefined;
  readonly after: ReadonlyArray<DataValue> | undefined;
  readonly changes: ReadonlyArray<CellChange>;
  readonly columns: ReadonlyArray<number>;
}) => (
  <>
    {before === undefined ? null : (
      <Line
        n={n}
        row={before}
        changes={changes}
        columns={columns}
        side="before"
        standIns={standIns}
      />
    )}
    {after === undefined ? null : (
      <Line
        n={n}
        row={after}
        changes={changes}
        columns={columns}
        side="after"
        standIns={standIns}
      />
    )}
  </>
);
