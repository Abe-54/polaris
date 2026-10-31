/**
 * The Table tab's Data view (Paper D1/D2): the grid, then a footer with the row count, "Add n rows
 * to agent session ⌘L" for the selected rows, and Copy as CSV (the selection, else every row).
 */
import { Button, CopyButton, EmptyState, Kbd, PixelServerIcon, useCopyWrite } from "@polaris/ui";
import { useEffect, useMemo, useRef } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useCommands } from "../../../../shell/hooks.ts";
import { DataGrid } from "../../grid/DataGrid.tsx";
import type { GridColumn } from "../../grid/columns.ts";
import { toCsv } from "../../grid/csv.ts";
import { type GridSelection, selectedRows } from "../../grid/selection.ts";
import { addLabel, useAddPlan, useAddRows } from "../../grid/useAddRows.tsx";
import type { DataRow, DataValue } from "../../grid/value.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { type Pages, ROW_CAP } from "./usePages.ts";

const number = (n: number) => n.toLocaleString("en-US");

const Count = ({ pages }: { readonly pages: Pages }) => {
  const n = pages.rows.length;

  if (pages.status === "loading") return <span>Loading rows…</span>;

  return (
    <span>
      <span className="text-text-default tabular font-mono">{number(n)}</span>
      {n === 1 ? " row" : " rows"} · {Math.round(pages.elapsedMs)} ms
      {n >= ROW_CAP ? ` · the first ${number(ROW_CAP)}; filter to see the rest` : null}
      {!pages.done && n < ROW_CAP ? " · more as you scroll" : null}
    </span>
  );
};

export interface TableDataProps {
  readonly at: DataSessionKey;
  readonly source: string;
  /** What the rows are, for ⌘L: the table, and its filter when there is one. */
  readonly from: string;
  readonly columns: ReadonlyArray<GridColumn>;
  readonly pages: Pages;
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onMore: () => void;
  readonly onForeignKey: (column: GridColumn, value: DataValue | undefined) => void;
}

export const TableData = (props: TableDataProps) => {
  const { at, source, from, columns, pages, selection } = props;
  const add = useAddRows(at);
  const commands = useCommands();
  const write = useCopyWrite();
  const picked = selectedRows(selection);

  const chosen = (): ReadonlyArray<DataRow> =>
    picked.flatMap((i) => (pages.rows[i] === undefined ? [] : [pages.rows[i]]));

  const rows = useMemo(chosen, [selection, pages.rows]);
  const plan = useAddPlan(at, rows.length === 0 ? null : { source, from, columns, rows });
  const addChosen = () => add({ source, from, columns, rows });
  const latest = useRef({ addChosen, count: plan.rows });

  latest.current = { addChosen, count: plan.rows };

  useEffect(
    () =>
      commands.register({
        "data.addRowsToSession": {
          run: () => latest.current.addChosen(),
          enabled: () => latest.current.count > 0,
        },
      }),
    [commands]
  );

  const csv = () => toCsv(columns, picked.length > 0 ? chosen() : pages.rows);

  return (
    <>
      <DataGrid
        label={from}
        columns={columns}
        rows={pages.rows}
        selection={selection}
        onSelectionChange={props.onSelectionChange}
        onForeignKey={props.onForeignKey}
        onNearEnd={props.onMore}
        onCopy={() => void write(csv())}
        empty={
          pages.status === "ready" && pages.done ? (
            <EmptyState
              icon={<PixelServerIcon size={24} className="text-text-strong" />}
              title="No rows"
              fact={from.includes(" where ") ? "No row matches the filter" : "The table is empty"}
            />
          ) : undefined
        }
      />
      <footer
        data-testid="data-table-footer"
        className="border-hairline text-caption text-text-subtle flex h-11 shrink-0 items-center gap-3 border-t px-3.5"
      >
        <span className="min-w-0 flex-1 truncate">
          <Count pages={pages} />
        </span>
        <Button
          size="default"
          variant="ghost"
          disabled={plan.rows === 0}
          onClick={addChosen}
          data-testid="data-add-rows"
          className="text-text-default rounded-full shadow-[inset_0_0_0_1px_var(--color-hairline)]"
          title={picked.length === 0 ? "Select rows to add them" : undefined}
        >
          {addLabel(plan)}
          <Kbd variant="plain">{commandShortcut("data.addRowsToSession")}</Kbd>
        </Button>
        <CopyButton
          text={csv}
          label="Copy as CSV"
          variant="button"
          buttonVariant="ghost"
          buttonSize="default"
        />
      </footer>
    </>
  );
};
