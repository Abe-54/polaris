/**
 * The Table tab's edits over its rows: which cells edit (keyed by the primary key), the rows with
 * staged and written values laid over, and why the table is read-only when it is.
 */
import type { DataSource, TableDetail } from "@polaris/protocol";
import { Predicate } from "effect";
import { useCallback, useMemo } from "react";
import type { GridEditing } from "../../../grid/DataGrid.tsx";
import { type ColumnFacts, editorFor, NO_KEY } from "../../../grid/editors.ts";
import type { CellAt } from "../../../grid/selection.ts";
import type { DataRow, DataValue } from "../../../grid/value.ts";
import type { DataSessionKey } from "../../../model/store.ts";
import type { TableRef } from "../../../model/tabs.ts";
import { type CommitTarget, writesBlocked } from "./commit.ts";
import { keyIndex, overlay } from "./staged.ts";
import { stageEdit, undoEdit, useTabEdits } from "./store.ts";

export interface TableEditsInput {
  readonly at: DataSessionKey;
  readonly tabId: string;
  readonly table: TableRef;
  readonly detail: TableDetail | null;
  readonly source: DataSource | null;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<DataRow>;
}

const LOADING = "The table is still loading";

const UNMATCHABLE = "This row's key was cut short or is binary, so the row can't be matched";

/** Why nothing in the table edits, or null when its cells can. */
const readOnlyReason = (source: DataSource, keyCols: ReadonlyArray<number>): string | null => {
  if (keyCols.length === 0) return NO_KEY;

  if (keyCols.includes(-1)) return "The primary key isn't among the columns shown";

  return writesBlocked(source);
};

const exact = (value: DataValue | undefined) =>
  value === undefined ||
  !Predicate.isObject(value) ||
  !(Predicate.isTagged(value, "Bytes") || Predicate.isTagged(value, "Truncated"));

export const useTableEdits = (input: TableEditsInput) => {
  const { at, tabId, detail, source, columns, rows } = input;
  const edits = useTabEdits(at, tabId);

  const keyNames = useMemo(
    () => detail?.columns.filter((c) => c.pk).map((c) => c.name) ?? [],
    [detail]
  );

  const keyCols = useMemo(() => keyNames.map((n) => columns.indexOf(n)), [keyNames, columns]);
  const loading = detail === null || source === null;
  const readOnly = loading ? null : readOnlyReason(source, keyCols);
  const index = useMemo(() => keyIndex(rows, keyCols), [rows, keyCols]);

  const shown = useMemo(
    () =>
      overlay(rows, columns, index, {
        written: edits.written,
        staged: edits.staged.cells.values(),
      }),
    [rows, columns, index, edits.written, edits.staged]
  );

  const isStaged = useCallback(
    (row: number, col: number) => shown.staged.get(row)?.has(col) ?? false,
    [shown]
  );

  const committing = edits.commit.status === "committing";

  const editing = useMemo((): GridEditing => {
    const keyOf = (row: number) => keyCols.map((c) => rows[row]?.[c] ?? null);

    const factsOf = (col: number): ColumnFacts | null => {
      const name = columns[col];

      return detail?.columns.find((c) => c.name === name) ?? null;
    };

    return {
      editorAt: ({ row, col }: CellAt) => {
        const facts = factsOf(col);

        if (loading) return LOADING;

        if (readOnly !== null) return readOnly;

        if (committing) return "A commit is on its way";

        if (facts === null) return "This column isn't in the table, so it can't be edited";

        if (!keyCols.every((c) => exact(rows[row]?.[c]))) return UNMATCHABLE;

        return editorFor(facts, shown.rows[row]?.[col] ?? null);
      },
      onStage: ({ row, col }, value) => {
        const column = columns[col];

        if (column === undefined) return;
        stageEdit(at, tabId, {
          key: keyOf(row),
          column,
          before: shown.rows[row]?.[col] ?? null,
          value,
        });
      },
      onUndo: () => undoEdit(at, tabId),
    };
  }, [at, tabId, columns, detail, keyCols, loading, readOnly, committing, rows, shown]);

  const target: CommitTarget | null =
    source === null || loading || readOnly !== null
      ? null
      : { at, tabId, source, table: input.table, primaryKey: keyNames };

  return { tabId, source, edits, rows: shown.rows, isStaged, editing, readOnly, target };
};
