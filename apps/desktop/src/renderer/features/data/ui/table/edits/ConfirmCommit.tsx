/**
 * The remote bulk-commit confirm (DESIGN.md, Data: Approvals; Paper D3 "Remote bulk commit
 * confirm"): the source label's colour as the card's top bar, its kicker, "Commit 3 changes to
 * 2 rows?", a short diff of the staged rows, and Cancel / "Commit to ‹label›" in one transaction.
 */
import type { DataSource } from "@polaris/protocol";
import { Button, cn, Dialog, DialogContent, DialogDescription, DialogTitle } from "@polaris/ui";
import { Match, Predicate } from "effect";
import { kickerText, LABEL_TONES } from "../../../model/source.ts";
import type { DataValue } from "../../../grid/value.ts";
import { countStaged, type Staged, type StagedCell, stagedRows } from "./staged.ts";

/** The most rows the diff lists; the rest are counted. */
export const DIFF_ROWS = 4;

const CLIP = 32;

/** The longest label the commit button names; past it the button names the source. */
const LABEL_ON_BUTTON = 16;

const clip = (text: string) => (text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Quoted and clipped; a uuid shortened as the grid shows it. */
const quoted = (text: string) => {
  const short = UUID.test(text) ? `${text.slice(0, 4)}…${text.slice(-3)}` : text;

  return `'${clip(short.replaceAll("'", "''")).replace(/[\r\n]+/g, "⏎")}'`;
};

/** A value as the diff reads it: numbers bare, NULL, the rest quoted and clipped. */
export const literalOf = (value: DataValue): string => {
  if (value === null) return "NULL";

  if (Predicate.isString(value)) return quoted(value);

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return String(value);

  return Match.valueTags(value, {
    BigInt: (v) => v.value,
    Numeric: (v) => v.value,
    Json: (v) => quoted(v.text),
    Timestamp: (v) => quoted(v.iso),
    Bytes: (v) => `${v.length} bytes`,
    Truncated: (v) => quoted(v.preview),
  });
};

export interface DiffLine {
  readonly set: ReadonlyArray<{ readonly column: string; readonly value: string }>;
  readonly where: ReadonlyArray<{ readonly column: string; readonly value: string }>;
}

/** One line per staged row, the first DIFF_ROWS of them, and how many rows aren't listed. */
export const diffLines = (primaryKey: ReadonlyArray<string>, staged: Pick<Staged, "cells">) => {
  const rows = stagedRows(staged);

  const lines = rows.slice(0, DIFF_ROWS).map((row): DiffLine => ({
    set: row.cells.map((cell: StagedCell) => ({
      column: cell.column,
      value: literalOf(cell.value),
    })),
    where: primaryKey.map((column, i) => ({ column, value: literalOf(row.key[i] ?? null) })),
  }));

  return { lines, more: rows.length - lines.length };
};

const Kw = ({ children }: { readonly children: string }) => (
  <span className="text-syntax-keyword">{children}</span>
);

const Value = ({ value }: { readonly value: string }) => (
  <span className={value.startsWith("'") ? "text-syntax-string" : "text-text-default"}>
    {value}
  </span>
);

/** One staged row: its update on the first line, its key and "-- 1 row" on the second. */
const Line = ({ table, line }: { readonly table: string; readonly line: DiffLine }) => (
  <div data-testid="data-confirm-line">
    <div className="truncate">
      <Kw>update</Kw> {table} <Kw>set</Kw>{" "}
      {line.set.map(({ column, value }, i) => (
        <span key={column}>
          {i === 0 ? null : ", "}
          {column} = <Value value={value} />
        </span>
      ))}
    </div>
    <div className="flex gap-3 pl-[1ch]">
      <span className="min-w-0 truncate">
        <Kw>where</Kw>{" "}
        {line.where.map(({ column, value }, i) => (
          <span key={column}>
            {i === 0 ? null : " and "}
            {column} = <Value value={value} />
          </span>
        ))}
        ;
      </span>
      <span className="text-syntax-comment shrink-0">-- 1 row</span>
    </div>
  </div>
);

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export interface ConfirmCommitProps {
  readonly open: boolean;
  readonly source: DataSource;
  readonly table: string;
  readonly primaryKey: ReadonlyArray<string>;
  readonly staged: Pick<Staged, "cells">;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export const ConfirmCommit = (props: ConfirmCommitProps) => {
  const { source, staged } = props;
  const count = countStaged(staged);
  const { lines, more } = diffLines(props.primaryKey, staged);
  const tone = LABEL_TONES[source.label.colour];
  const label = source.label.text.trim();
  // The button names the label ("Commit to production"), or the source when the label is long.
  const target = label === "" || label.length > LABEL_ON_BUTTON ? source.name : label.toLowerCase();

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogContent data-testid="data-confirm-commit" className="w-[430px] p-0">
        <div
          aria-hidden
          data-testid="data-confirm-bar"
          data-colour={source.label.colour}
          className={cn("h-1 shrink-0", tone.fill === "" ? "bg-text-faint" : tone.fill)}
        />
        <div className="flex flex-col gap-1.5 px-[18px] pt-4 pb-3">
          <span
            className={cn(
              "text-micro truncate font-mono font-medium tracking-[0.06em]",
              source.label.colour === "none" ? "text-text-subtle" : tone.text
            )}
          >
            {kickerText(source)} · {source.name.toUpperCase()}
          </span>
          <DialogTitle className="text-text-strong text-[16px] leading-[22px] font-medium">
            Commit {plural(count.changes, "change", "changes")} to{" "}
            {plural(count.rows, "row", "rows")}?
          </DialogTitle>
          <DialogDescription className="text-body text-text-subtle">
            These changes touch more than one row of {props.table} on a remote data source, so
            they're confirmed first. Single-row edits commit without this.
          </DialogDescription>
        </div>
        <div className="bg-well ring-hairline text-code-inline mx-3.5 rounded-[12px] px-3 py-2.5 font-mono ring-1 ring-inset">
          {lines.map((line, i) => (
            <Line key={i} table={props.table} line={line} />
          ))}
          {more === 0 ? null : (
            <div className="text-syntax-comment">
              -- and {plural(more, "more row", "more rows")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 py-3.5 pr-3.5 pl-[18px]">
          <span className="text-micro text-text-subtle flex-1 font-mono tracking-[0.06em] whitespace-nowrap">
            ONE TRANSACTION
          </span>
          {/* A remote write: ↵ cancels until the user picks Commit (DESIGN.md, Discard asks). */}
          <Button variant="ghost" autoFocus className="rounded-full" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            className="max-w-[240px] min-w-0 rounded-full shadow-[inset_0_0_0_1px_var(--color-hairline)]"
            onClick={props.onConfirm}
            data-testid="data-confirm-commit-button"
          >
            <span className="truncate">Commit to {target}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
