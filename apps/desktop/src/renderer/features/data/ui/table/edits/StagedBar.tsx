/**
 * The footer's edit state (DESIGN.md, Data: Table tab; Paper D1): "1 change staged · 1 row" in
 * tan with Discard and Commit ⌘S, the last commit's word, or why the table is read-only. A
 * failed commit keeps everything staged and says why above the footer, in the user's words.
 */
import { Button, Kbd } from "@polaris/ui";
import { commandShortcut } from "../../../../../../shared/keymap.ts";
import { commitCopy } from "./commitCopy.ts";
import { changesLabel, countStaged, type SortedStaged, stagedLabel } from "./staged.ts";
import type { TabEdits } from "./store.ts";

export interface StagedBarProps {
  readonly edits: TabEdits;
  /** What a commit would send: the count is of these; a changed conflict holds Commit back. */
  readonly sorted: SortedStaged;
  readonly readOnly: string | null;
  /** The remote source's writes are what block edits: the connection card can change that. */
  readonly onConnection: (() => void) | null;
  readonly onDiscard: () => void;
  readonly onCommit: () => void;
}

const ReadOnly = ({
  reason,
  onConnection,
}: {
  readonly reason: string;
  readonly onConnection: (() => void) | null;
}) => (
  <span className="flex min-w-0 items-center gap-2" data-testid="data-read-only">
    <span className="text-caption text-text-subtle min-w-0 truncate" title={reason}>
      Read-only · {reason}
    </span>
    {onConnection === null ? null : (
      <Button size="sm" variant="ghost" onClick={onConnection} data-testid="data-open-connection">
        Connection…
      </Button>
    )}
  </span>
);

export const StagedBar = ({
  edits,
  sorted,
  readOnly,
  onConnection,
  onDiscard,
  onCommit,
}: StagedBarProps) => {
  const count = countStaged({ cells: sorted.send });
  const committing = edits.commit.status === "committing";
  const held = sorted.changed.length > 0;

  if (count.changes === 0) {
    if (edits.commit.status === "committed")
      return (
        <span
          className="text-caption text-text-subtle shrink-0"
          data-testid="data-committed"
          role="status"
        >
          Committed {changesLabel(edits.commit.count)}
        </span>
      );

    return readOnly === null ? null : <ReadOnly reason={readOnly} onConnection={onConnection} />;
  }

  return (
    <span className="flex shrink-0 items-center gap-3" data-testid="data-staged">
      <span className="text-caption text-git-modified-text flex items-center gap-1.5" role="status">
        <span aria-hidden className="bg-git-modified size-1.5 shrink-0 rounded-full" />
        {stagedLabel(count)}
      </span>
      <Button
        variant="ghost"
        className="rounded-full"
        disabled={committing}
        onClick={onDiscard}
        data-testid="data-discard"
      >
        Discard
      </Button>
      <Button
        variant="secondary"
        className="rounded-full shadow-[inset_0_0_0_1px_var(--color-hairline)]"
        disabled={committing || held}
        title={held ? "Overwrite or drop each conflict to commit" : undefined}
        onClick={onCommit}
        data-testid="data-commit"
      >
        {committing ? "Committing…" : "Commit"}
        <Kbd variant="plain">{commandShortcut("data.commitEdits")}</Kbd>
      </Button>
    </span>
  );
};

/** A failed commit, above the footer: the code, what happened and what to do. */
export const CommitError = ({
  edits,
  keyNames,
}: {
  readonly edits: TabEdits;
  readonly keyNames: ReadonlyArray<string>;
}) => {
  if (edits.commit.status !== "failed") return null;
  const { error } = edits.commit;
  const copy = commitCopy(error, keyNames);

  return (
    <div
      role="alert"
      data-testid="data-commit-error"
      className="border-hairline flex shrink-0 flex-col gap-0.5 border-t px-3.5 py-2"
    >
      <span className="text-caption text-failed-text min-w-0">
        <span className="font-mono">{error.code}</span> · Commit failed · {copy.message}
      </span>
      <span className="text-caption text-text-subtle">{copy.fix} Your edits are still staged.</span>
    </div>
  );
};
