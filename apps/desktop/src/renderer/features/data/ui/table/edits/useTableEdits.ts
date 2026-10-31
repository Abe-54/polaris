/**
 * The Table tab's edits over its rows: which cells edit (keyed by the primary key in its declared
 * order), the rows with staged and written values laid over, what a commit would send, and why
 * the table is read-only when it is.
 */
import type { DataSource, TableDetail } from "@polaris/protocol";
import { Predicate } from "effect";
import { useCallback, useMemo } from "react";
import type { GridEditing } from "../../../grid/DataGrid.tsx";
import { type ColumnFacts, editorFor, NO_KEY, sameTyped } from "../../../grid/editors.ts";
import type { CellAt } from "../../../grid/selection.ts";
import type { DataRow, DataValue } from "../../../grid/value.ts";
import type { DataSessionKey } from "../../../model/store.ts";
import type { TableRef } from "../../../model/tabs.ts";
import { type CommitTarget, sendable, writesBlocked } from "./commit.ts";
import { cellId, keyIndex, overlay } from "./staged.ts";
import { stageEdit, undoEdit, useTabEdits } from "./store.ts";

export interface TableEditsInput {
  readonly at: DataSessionKey;
  readonly tabId: string;
  readonly table: TableRef;
  readonly detail: TableDetail | null;
  readonly source: DataSource | null;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<DataRow>;
  /** The rows have been read, so a staged row missing from them isn't shown. */
  readonly ready?: boolean;
}

const LOADING = "The table is still loading";

const UNMATCHABLE = "This row's key was cut short or is binary, so the row can't be matched";

export const FLOAT_KEY =
  "This table's key is a floating-point value, so its rows can't be matched exactly";

export const NO_KEY_ORDER =
  "This Host's Daemon doesn't say the key's order; upgrade it to edit this table";

const FLOAT = /^(?:real|float[48]?|double(?: precision)?)\b/i;

/** The key's columns as declared, from the Daemon's catalog; null when its order is unknown. */
const declaredKey = (detail: TableDetail | null): ReadonlyArray<string> | null => {
  const marked = detail?.columns.filter((c) => c.pk).map((c) => c.name) ?? [];

  if (detail?.primaryKey !== undefined) return detail.primaryKey;

  return marked.length > 1 ? null : marked;
};

/** Why nothing in the table edits, or null when its cells can. */
const readOnlyReason = (
  source: DataSource,
  detail: TableDetail,
  keyNames: ReadonlyArray<string> | null,
  keyCols: ReadonlyArray<number>
): string | null => {
  if (keyNames === null) return NO_KEY_ORDER;

  if (keyCols.length === 0) return NO_KEY;

  if (keyCols.includes(-1)) return "The primary key isn't among the columns shown";

  const types = keyNames.map((n) => detail.columns.find((c) => c.name === n)?.type ?? "");

  if (types.some((t) => FLOAT.test(t.trim()))) return FLOAT_KEY;

  return writesBlocked(source);
};

const exact = (value: DataValue | undefined) =>
  value === undefined ||
  !Predicate.isObject(value) ||
  !(Predicate.isTagged(value, "Bytes") || Predicate.isTagged(value, "Truncated"));

export const useTableEdits = (input: TableEditsInput) => {
  const { at, tabId, detail, source, columns, rows, ready = true } = input;
  const edits = useTabEdits(at, tabId);
  const keyNames = useMemo(() => declaredKey(detail), [detail]);

  const keyCols = useMemo(
    () => (keyNames ?? []).map((n) => columns.indexOf(n)),
    [keyNames, columns]
  );

  const loading = detail === null || source === null;
  const readOnly = loading ? null : readOnlyReason(source, detail, keyNames, keyCols);
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
    (row: number, col: number): boolean | "conflict" =>
      shown.conflicts.get(row)?.has(col) === true
        ? "conflict"
        : (shown.staged.get(row)?.has(col) ?? false),
    [shown]
  );

  const committing = edits.commit.status === "committing";

  const editing = useMemo((): GridEditing => {
    const keyOf = (row: number) => keyCols.map((c) => rows[row]?.[c] ?? null);

    const factsOf = (col: number): ColumnFacts | null => {
      const name = columns[col];
      const facts = detail?.columns.find((c) => c.name === name);

      if (facts === undefined) return null;

      return source === null ? facts : { ...facts, engine: source.engine };
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
      onStage: ({ row, col }, typed) => {
        const column = columns[col];
        const facts = factsOf(col);

        if (column === undefined || facts === null) return;
        const key = keyOf(row);
        const now = shown.rows[row]?.[col] ?? null;
        const before = edits.staged.cells.get(cellId(key, column))?.before ?? now;
        const how = editorFor(facts, now);

        if (Predicate.isString(how)) return;

        // A typed no-op ("42" over 42, the same instant reformatted) changes nothing.
        if (sameTyped(how, now, typed)) return;
        const value = sameTyped(how, before, typed) ? before : typed;

        stageEdit(at, tabId, { key, column, before: now, value });
      },
      onUndo: () => undoEdit(at, tabId),
    };
  }, [
    at,
    tabId,
    columns,
    detail,
    source,
    keyCols,
    loading,
    readOnly,
    committing,
    rows,
    shown,
    edits.staged,
  ]);

  // Until the rows are read every staged row counts as shown, but nothing commits.
  const target: CommitTarget | null =
    source === null || loading || readOnly !== null || keyNames === null || !ready
      ? null
      : {
          at,
          tabId,
          source,
          table: input.table,
          primaryKey: keyNames,
          shown: (row) => index.has(row),
        };

  const sorted = useMemo(
    () => sendable({ shown: (row) => !ready || index.has(row) }, edits.staged),
    [edits.staged, index, ready]
  );

  return {
    tabId,
    source,
    edits,
    rows: shown.rows,
    isStaged,
    editing,
    readOnly,
    target,
    sorted,
    keyNames: keyNames ?? [],
  };
};
