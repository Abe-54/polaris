/**
 * Staged edits a commit can't send as they are, above the footer (DESIGN.md, Data: Table tab):
 * cells the database changed since they were staged (Overwrite or Drop edit), rows it no longer
 * has, and rows not shown (a filter, a re-key). None is ever sent without the user seeing it.
 */
import { Button } from "@polaris/ui";
import { cellOf, displayOf } from "../../../grid/value.ts";
import { keyLabel } from "./commitCopy.ts";
import { cellId, type SortedStaged, type StagedCell } from "./staged.ts";

export interface ConflictsProps {
  readonly sorted: SortedStaged;
  readonly keyNames: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onOverwrite: (cells: ReadonlyArray<string>) => void;
  readonly onDrop: (ids: ReadonlyArray<{ cell?: string; row?: string }>) => void;
}

/** The most lines listed; the rest are counted. */
const MAX_LINES = 50;

const shown = (value: StagedCell["value"]) => displayOf(cellOf(value));

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const headline = ({ changed, gone, hidden }: SortedStaged) => {
  if (changed.length > 0)
    return `Nothing was written: ${plural(changed.length, "staged cell", "staged cells")} changed since you staged ${changed.length === 1 ? "it" : "them"}. Overwrite or drop each to commit.`;

  if (gone.size > 0)
    return `${plural(gone.size, "staged row no longer exists", "staged rows no longer exist")}; ${gone.size === 1 ? "its" : "their"} changes won't commit.`;

  const changes = [...hidden.values()].reduce((n, cells) => n + cells.length, 0);

  return `${plural(changes, "change", "changes")} on rows not shown won't commit until the rows are shown.`;
};

interface Line {
  readonly id: string;
  readonly where: string;
  readonly what: string;
  readonly overwrite?: string;
  readonly drop: { cell?: string; row?: string };
}

const linesOf = (sorted: SortedStaged, keyNames: ReadonlyArray<string>): ReadonlyArray<Line> => [
  ...sorted.changed.map((cell): Line => {
    const id = cellId(cell.key, cell.column);
    const theirs = cell.conflict?.kind === "changed" ? cell.conflict.value : null;

    return {
      id,
      where: `${keyLabel(keyNames, cell.key)} · ${cell.column}`,
      what: `Changed since you staged it · was ${shown(cell.before)}, now ${shown(theirs)} · yours ${shown(cell.value)}`,
      overwrite: id,
      drop: { cell: id },
    };
  }),
  ...[...sorted.gone].map(([row, cells]): Line => ({
    id: `gone:${row}`,
    where: keyLabel(keyNames, cells[0]?.key ?? []),
    what: `Row no longer exists · ${plural(cells.length, "change", "changes")}`,
    drop: { row },
  })),
  ...[...sorted.hidden].map(([row, cells]): Line => ({
    id: `hidden:${row}`,
    where: keyLabel(keyNames, cells[0]?.key ?? []),
    what: `Row not shown · ${plural(cells.length, "change", "changes")}`,
    drop: { row },
  })),
];

export const Conflicts = ({ sorted, keyNames, disabled, onOverwrite, onDrop }: ConflictsProps) => {
  const lines = linesOf(sorted, keyNames);

  if (lines.length === 0) return null;
  const failing = sorted.changed.length > 0;

  return (
    <div
      role={failing ? "alert" : "status"}
      data-testid="data-conflicts"
      className="border-hairline flex max-h-48 shrink-0 flex-col gap-1 overflow-y-auto border-t px-3.5 py-2"
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-caption min-w-0 flex-1 ${failing ? "text-failed-text" : "text-text-subtle"}`}
          data-testid="data-conflicts-headline"
        >
          {headline(sorted)}
        </span>
        {sorted.changed.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onOverwrite(sorted.changed.map((c) => cellId(c.key, c.column)))}
          >
            Overwrite all
          </Button>
        ) : null}
        {lines.length > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onDrop(lines.map((line) => line.drop))}
          >
            Drop all
          </Button>
        ) : null}
      </div>
      <ul className="flex flex-col">
        {lines.slice(0, MAX_LINES).map((line) => (
          <li
            key={line.id}
            data-testid="data-conflict"
            className="text-caption flex h-7 min-w-0 items-center gap-3"
          >
            <span className="text-code-inline text-text-strong shrink-0 font-mono">
              {line.where}
            </span>
            <span className="text-text-subtle min-w-0 flex-1 truncate" title={line.what}>
              {line.what}
            </span>
            {line.overwrite === undefined ? null : (
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                data-testid="data-conflict-overwrite"
                onClick={() => onOverwrite([line.overwrite ?? ""])}
              >
                Overwrite
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              data-testid="data-conflict-drop"
              onClick={() => onDrop([line.drop])}
            >
              Drop edit
            </Button>
          </li>
        ))}
      </ul>
      {lines.length > MAX_LINES ? (
        <span className="text-caption text-text-subtle">
          and {(lines.length - MAX_LINES).toLocaleString("en-US")} more
        </span>
      ) : null}
    </div>
  );
};
