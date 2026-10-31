/**
 * The Table tab's Data view (Paper D1/D2): the grid, then a footer with the row count, the staged
 * edits with Discard and Commit ⌘S, "Add n rows to agent session ⌘L" for the selected rows, and
 * Copy as CSV (the selection, else every row).
 */
import { Button, CopyButton, EmptyState, Kbd, PixelServerIcon, useCopyWrite } from "@polaris/ui";
import { useEffect, useMemo, useRef } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useCommands } from "../../../../shell/hooks.ts";
import { useDataApi } from "../../data/hooks.tsx";
import { DataGrid } from "../../grid/DataGrid.tsx";
import type { GridColumn } from "../../grid/columns.ts";
import { toCsv } from "../../grid/csv.ts";
import { type GridSelection, selectedRows } from "../../grid/selection.ts";
import { addLabel, useAddPlan, useAddRows } from "../../grid/useAddRows.tsx";
import type { DataRow, DataValue } from "../../grid/value.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { openConnectionCard } from "../connection/cardStore.ts";
import { cancelCommit, requestCommit, runCommit, writesBlocked } from "./edits/commit.ts";
import { ConfirmCommit } from "./edits/ConfirmCommit.tsx";
import { CommitError, StagedBar } from "./edits/StagedBar.tsx";
import { discardEdits } from "./edits/store.ts";
import type { useTableEdits } from "./edits/useTableEdits.ts";
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
  /** The tab's edits: the rows as shown (staged values laid over), the grid's editing, commit. */
  readonly edit: ReturnType<typeof useTableEdits>;
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onMore: () => void;
  readonly onForeignKey: (column: GridColumn, value: DataValue | undefined) => void;
}

export const TableData = (props: TableDataProps) => {
  const { at, source, from, columns, pages, selection, edit } = props;
  const api = useDataApi();
  const shown = edit.rows;
  const add = useAddRows(at);
  const commands = useCommands();
  const write = useCopyWrite();
  const picked = selectedRows(selection);

  const chosen = (): ReadonlyArray<DataRow> =>
    picked.flatMap((i) => (shown[i] === undefined ? [] : [shown[i]]));

  const rows = useMemo(chosen, [selection, shown]);
  const plan = useAddPlan(at, rows.length === 0 ? null : { source, from, columns, rows });
  const addChosen = () => add({ source, from, columns, rows });
  const target = edit.target;
  const commit = () => (target === null ? undefined : requestCommit(api, target));
  const staged = edit.edits.staged.cells.size;
  const latest = useRef({ addChosen, count: plan.rows, commit, staged });

  latest.current = { addChosen, count: plan.rows, commit, staged };

  useEffect(
    () =>
      commands.register({
        "data.addRowsToSession": {
          run: () => latest.current.addChosen(),
          enabled: () => latest.current.count > 0,
        },
        "data.commitEdits": {
          run: () => latest.current.commit(),
          enabled: () => latest.current.staged > 0,
        },
      }),
    [commands]
  );

  const csv = () => toCsv(columns, picked.length > 0 ? chosen() : shown);

  const blockedByWrites =
    edit.target === null && edit.source !== null && writesBlocked(edit.source) !== null;

  return (
    <>
      <DataGrid
        label={from}
        columns={columns}
        rows={shown}
        isStaged={edit.isStaged}
        editing={edit.editing}
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
      <CommitError edits={edit.edits} />
      <footer
        data-testid="data-table-footer"
        className="border-hairline text-caption text-text-subtle flex h-11 shrink-0 items-center gap-3 border-t px-3.5"
      >
        <span className="min-w-0 flex-1 truncate">
          <Count pages={pages} />
        </span>
        <StagedBar
          edits={edit.edits}
          readOnly={edit.readOnly}
          onConnection={blockedByWrites ? openConnectionCard : null}
          onDiscard={() => discardEdits(at, edit.tabId)}
          onCommit={commit}
        />
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
      {target === null || target.source.locality !== "remote" ? null : (
        <ConfirmCommit
          open={edit.edits.commit.status === "confirming"}
          source={target.source}
          table={target.table.name}
          primaryKey={target.primaryKey}
          staged={edit.edits.staged}
          onCancel={() => cancelCommit(at, edit.tabId)}
          onConfirm={() => void runCommit(api, target)}
        />
      )}
    </>
  );
};
