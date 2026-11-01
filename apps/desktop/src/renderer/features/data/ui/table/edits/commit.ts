/**
 * Committing a tab's staged edits through `data.edits.commit`: one transaction keyed by primary
 * key, each cell checked against the value it was staged from. Only a bulk commit (more than one
 * row) on a Remote Data Source confirms first.
 */
import type { DataSource } from "@polaris/protocol";
import type { IpcError } from "../../../../../../shared/api.ts";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import type { DataSessionKey } from "../../../model/store.ts";
import type { TableRef } from "../../../model/tabs.ts";
import {
  cellId,
  countStaged,
  keepCells,
  markConflicts,
  sameValue,
  type Staged,
  sortStaged,
  stagedRows,
} from "./staged.ts";
import { changeEdits, changeOpenEdits, editsOf } from "./store.ts";

export interface CommitTarget {
  readonly at: DataSessionKey;
  readonly tabId: string;
  readonly source: DataSource;
  readonly table: TableRef;
  /** The key's columns in their declared order (TableDetail), never the columns' order. */
  readonly primaryKey: ReadonlyArray<string>;
  /** Whether a row (by `rowId`) is among those shown; edits on other rows aren't sent. */
  readonly shown: (row: string) => boolean;
}

/** A remote commit touching more than one row asks first; a single-row edit doesn't. */
export const needsConfirm = (source: Pick<DataSource, "locality">, staged: Pick<Staged, "cells">) =>
  source.locality === "remote" && countStaged(staged).rows > 1;

/** Why the user's own edits can't be written to `source`, or null when they can (W's rule). */
export const writesBlocked = (
  source: Pick<DataSource, "locality" | "access" | "writes">
): string | null => {
  if (source.locality === "local")
    return source.writes === "off" ? "Writes are off for this data source" : null;

  if (source.access !== "approved") return "Writes need this remote data source approved first";

  return source.writes === "off" ? "Writes are off for this remote data source" : null;
};

/** What a commit sends now: edits on shown rows, not those the database said are gone. */
export const sendable = (target: Pick<CommitTarget, "shown">, staged: Staged) =>
  sortStaged(staged, target.shown);

export const editsInput = (
  target: CommitTarget,
  staged: Pick<Staged, "cells">
): CommitEditsInput => ({
  source: target.source.name,
  table: target.table,
  primaryKey: target.primaryKey,
  edits: stagedRows(staged).flatMap((row) =>
    row.cells.map((cell) => ({
      key: cell.key,
      column: cell.column,
      before: cell.before,
      value: cell.value,
    }))
  ),
});

const UNSUPPORTED: IpcError = {
  code: "Unsupported",
  message: "This Host can't write data yet",
  fix: "Upgrade the Daemon on this Host to commit edits.",
};

/** ⌘S and the footer's Commit: confirm first when it should, else commit now. */
export const requestCommit = (api: DataApi, target: CommitTarget) => {
  const { staged, commit } = editsOf(target.at, target.tabId);
  const sorted = sendable(target, staged);

  if (sorted.send.size === 0 || sorted.changed.length > 0 || commit.status === "committing") return;

  if (needsConfirm(target.source, { cells: sorted.send }))
    return changeEdits(target.at, target.tabId, (e) => ({
      ...e,
      commit: { status: "confirming" },
    }));

  void runCommit(api, target);
};

export const cancelCommit = (at: DataSessionKey, tabId: string) =>
  changeEdits(at, tabId, (e) =>
    e.commit.status === "confirming" ? { ...e, commit: { status: "idle" } } : e
  );

/**
 * Sends what can be sent now. On success the sent cells leave the staged set (unless edited
 * again meanwhile) and show as written; on failure everything stays staged with the error, and a
 * conflict marks the cells it names. A tab closed meanwhile isn't brought back.
 */
export const runCommit = async (api: DataApi, target: CommitTarget) => {
  const { at, tabId } = target;
  const { staged } = editsOf(at, tabId);
  const { send } = sendable(target, staged);
  const sent = keepCells(staged, (cell) => send.has(cellId(cell.key, cell.column)));

  changeEdits(at, tabId, (e) => ({ ...e, commit: { status: "committing" } }));

  const result =
    api.commitEdits === undefined
      ? ({ ok: false, error: UNSUPPORTED } as const)
      : await api.commitEdits(at, editsInput(target, sent));

  if (!result.ok) {
    const { conflicts } = result.error;

    return changeOpenEdits(at, tabId, (e) =>
      conflicts === undefined
        ? { ...e, commit: { status: "failed", error: result.error } }
        : { ...e, staged: markConflicts(e.staged, conflicts), commit: { status: "idle" } }
    );
  }

  // The database's own spelling of what it stored ("1.50", 3), so the next edit checks against it.
  const stored = new Map(
    (result.value.written ?? []).map((w) => [cellId(w.key, w.column), w.value] as const)
  );

  const written = [...sent.cells].map(([id, cell]) =>
    stored.has(id) ? { ...cell, value: stored.get(id) ?? null } : cell
  );

  changeOpenEdits(at, tabId, (e) => {
    const cells = new Map(e.staged.cells);

    for (const [id, cell] of sent.cells) {
      const now = cells.get(id);

      if (now !== undefined && sameValue(now.value, cell.value)) cells.delete(id);
    }

    return {
      staged: { cells, history: e.staged.history.filter((h) => cells.has(h.id)) },
      written: [...e.written, ...written],
      commit: { status: "committed", count: countStaged(sent) },
    };
  });
};
