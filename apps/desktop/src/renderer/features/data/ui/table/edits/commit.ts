/**
 * Committing a tab's staged edits through `data.edits.commit`: one transaction keyed by primary
 * key. Only a bulk commit (more than one row) on a Remote Data Source confirms first.
 */
import type { DataSource } from "@polaris/protocol";
import type { IpcError } from "../../../../../../shared/api.ts";
import type { CommitEditsInput, DataApi } from "../../../data/api.ts";
import type { DataSessionKey } from "../../../model/store.ts";
import type { TableRef } from "../../../model/tabs.ts";
import { countStaged, sameValue, type Staged, stagedRows } from "./staged.ts";
import { changeEdits, editsOf } from "./store.ts";

export interface CommitTarget {
  readonly at: DataSessionKey;
  readonly tabId: string;
  readonly source: DataSource;
  readonly table: TableRef;
  readonly primaryKey: ReadonlyArray<string>;
}

/** A remote commit touching more than one row asks first; a single-row edit doesn't. */
export const needsConfirm = (source: Pick<DataSource, "locality">, staged: Staged) =>
  source.locality === "remote" && countStaged(staged).rows > 1;

/** Why the user's own edits can't be written to `source`, or null when they can (W's rule). */
export const writesBlocked = (
  source: Pick<DataSource, "locality" | "access" | "writes">
): string | null => {
  if (source.locality === "local") return null;

  if (source.access !== "approved") return "Writes need this remote data source approved first";

  return source.writes === "off" ? "Writes are off for this remote data source" : null;
};

export const editsInput = (target: CommitTarget, staged: Staged): CommitEditsInput => ({
  source: target.source.name,
  table: target.table,
  primaryKey: target.primaryKey,
  edits: stagedRows(staged).flatMap((row) =>
    row.cells.map((cell) => ({ key: cell.key, column: cell.column, value: cell.value }))
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

  if (staged.cells.size === 0 || commit.status === "committing") return;

  if (needsConfirm(target.source, staged))
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
 * Sends what is staged now. On success the sent cells leave the staged set (unless edited again
 * meanwhile) and show as written; on failure everything stays staged with the error.
 */
export const runCommit = async (api: DataApi, target: CommitTarget) => {
  const { at, tabId } = target;
  const sent = editsOf(at, tabId).staged;

  changeEdits(at, tabId, (e) => ({ ...e, commit: { status: "committing" } }));

  const result =
    api.commitEdits === undefined
      ? ({ ok: false, error: UNSUPPORTED } as const)
      : await api.commitEdits(at, editsInput(target, sent));

  if (!result.ok)
    return changeEdits(at, tabId, (e) => ({
      ...e,
      commit: { status: "failed", error: result.error },
    }));

  changeEdits(at, tabId, (e) => {
    const cells = new Map(e.staged.cells);

    for (const [id, cell] of sent.cells) {
      const now = cells.get(id);

      if (now !== undefined && sameValue(now.value, cell.value)) cells.delete(id);
    }

    return {
      staged: { cells, history: e.staged.history.filter((h) => cells.has(h.id)) },
      written: [...e.written, ...sent.cells.values()],
      commit: { status: "committed", count: countStaged(sent) },
    };
  });
};
