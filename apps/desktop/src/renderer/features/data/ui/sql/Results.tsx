/**
 * The SQL tab's results (DESIGN.md, Data → SQL tab; Paper D2): "Results · 5 rows", "Add n rows
 * to agent session ⌘L" and "Copy as CSV" over the grid; a database error with where it points.
 */
import { Button, type CopyState, Kicker, Kbd, useCopy } from "@polaris/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useCommands } from "../../../../shell/hooks.ts";
import { cmShortcut } from "../../../editor/cm/keys.ts";
import {
  DataGrid,
  emptySelection,
  type GridSelection,
  rowsLabel,
  selectedRows,
  toCsv,
  useAddRows,
} from "../../grid/index.ts";
import type { DataSessionKey } from "../../model/store.ts";
import type { ResultSet, SqlRun } from "../../sql/state.ts";
import { resultsKicker, sqlErrorLines } from "../../sql/copy.ts";

const COPY_LABEL: Readonly<Record<CopyState, string>> = {
  idle: "Copy as CSV",
  copied: "Copied",
  failed: "Couldn't copy",
};

const Quiet = ({ children }: { readonly children: string }) => (
  <p className="text-body text-text-subtle px-4 py-3" data-testid="data-sql-results-quiet">
    {children}
  </p>
);

const Failure = ({ run }: { readonly run: Extract<SqlRun, { status: "failed" }> }) => {
  const { message, where, fix } = sqlErrorLines(run.error, run.span);

  return (
    <div role="alert" data-testid="data-sql-error" className="flex flex-col gap-1 px-4 py-3">
      <p className="text-code text-failed-text font-mono [overflow-wrap:anywhere]">{message}</p>
      {where === null ? null : <p className="text-caption text-text-subtle">{where}</p>}
      {fix === null ? null : <p className="text-caption text-text-subtle">{fix}</p>}
    </div>
  );
};

interface DoneProps {
  readonly at: DataSessionKey;
  readonly source: string;
  readonly sql: string;
  readonly result: ResultSet;
}

const Done = ({ at, source, sql, result }: DoneProps) => {
  const [selection, setSelection] = useState<GridSelection>(emptySelection);
  const addRows = useAddRows(at);
  const commands = useCommands();
  const { state: copied, copy } = useCopy();
  // The selected rows, else every row shown.

  const rows = useMemo(() => {
    const picked = selectedRows(selection);

    return picked.length === 0
      ? result.rows
      : picked.flatMap((i) => {
          const row = result.rows[i];

          return row === undefined ? [] : [row];
        });
  }, [selection, result.rows]);

  const { columns } = result;

  const add = useCallback(
    () => addRows({ source, from: sql, columns, rows }),
    [addRows, source, sql, columns, rows]
  );

  const copyCsv = () => copy(toCsv(columns, rows));

  // ⌘L adds them while these results show.
  useEffect(
    () =>
      rows.length === 0 ? undefined : commands.register({ "data.addRowsToSession": { run: add } }),
    [commands, rows.length, add]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="data-sql-results">
      <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-4">
        <Kicker className="min-w-0 flex-1 truncate">{resultsKicker(result)}</Kicker>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          disabled={rows.length === 0}
          onClick={add}
          data-testid="data-sql-add-rows"
        >
          Add {rowsLabel(rows.length)} to agent session
          <Kbd variant="plain">{commandShortcut("data.addRowsToSession")}</Kbd>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={rows.length === 0}
          onClick={copyCsv}
          data-testid="data-sql-copy-csv"
        >
          {COPY_LABEL[copied]}
        </Button>
      </div>
      <div className="border-hairline flex min-h-0 flex-1 flex-col border-t">
        <DataGrid
          columns={result.columns}
          rows={result.rows}
          selection={selection}
          onSelectionChange={setSelection}
          onCopy={copyCsv}
          label="Query results"
          empty={<Quiet>No rows</Quiet>}
        />
      </div>
    </div>
  );
};

export interface ResultsProps {
  readonly at: DataSessionKey;
  readonly source: string;
  readonly run: SqlRun;
}

export const Results = ({ at, source, run }: ResultsProps) => {
  if (run.status === "idle")
    return <Quiet>{`Run the query with ${cmShortcut("Mod-Enter")}`}</Quiet>;

  if (run.status === "running") return <Quiet>Running…</Quiet>;

  if (run.status === "failed") return <Failure run={run} />;

  // Remounts per run, so a new result starts with no rows selected.
  return <Done key={run.id} at={at} source={source} sql={run.sql} result={run.result} />;
};
