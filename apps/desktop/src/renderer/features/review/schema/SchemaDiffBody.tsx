/**
 * The Schema Diff body in Review's diff pane (Paper D4, DESIGN.md Data → In Review): a card
 * per table in the diff colours with its columns, indexes and constraints, then the rows card.
 * Past `FOLD_AFTER` tables the rest wait behind "Show N more tables".
 */
import type { SchemaSourceDiff, SchemaTableDiff } from "@polaris/protocol";
import { Button, cn, EmptyState, Kbd, PixelForkIcon } from "@polaris/ui";
import { useState } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import { type LineChange, type SchemaLine, tableLines } from "./lines.ts";
import {
  baselineNote,
  currentName,
  FOLD_AFTER,
  rowsSplit,
  rowsWording,
  tableName,
  TRUNCATED_NOTE,
  unavailableReason,
} from "./model.ts";

export interface SchemaDiffBodyProps {
  readonly source: SchemaSourceDiff;
  /** "start → end of turn 7", "across this session". */
  readonly scope: string;
  /** Opens a table in Data mode; absent where Data can't be opened. */
  readonly onOpenTable?: ((table: string) => void) | undefined;
}

type Tone = LineChange | SchemaTableDiff["kind"];

const TEXT: Record<Tone, string> = {
  added: "text-diff-added-text",
  removed: "text-diff-removed-text",
  changed: "text-git-modified-text",
  renamed: "text-git-modified-text",
  same: "text-text-default",
};

const SIGN: Record<Tone, string> = {
  added: "+",
  removed: "−",
  changed: "~",
  renamed: "→",
  same: "",
};

const HEADER_BG: Record<SchemaTableDiff["kind"], string> = {
  added: "bg-diff-added-bg",
  removed: "bg-diff-removed-bg",
  changed: "bg-git-modified/12",
  renamed: "bg-git-modified/12",
};

const Line = ({ line }: { readonly line: SchemaLine }) => (
  <div
    data-testid="schema-line"
    data-change={line.change}
    className={cn(
      "gap-row-x flex min-w-0 items-baseline font-mono text-caption",
      TEXT[line.change]
    )}
  >
    <span aria-hidden="true" className="w-3 shrink-0 text-center">
      {SIGN[line.change]}
    </span>
    {line.what !== "column" && <span className="shrink-0">{line.what}</span>}
    <span className="max-w-[40%] shrink-0 truncate" title={line.name}>
      {line.name}
    </span>
    <span
      className={cn("min-w-0 flex-1 truncate", line.change === "same" && "text-text-subtle")}
      title={line.detail}
    >
      {line.detail}
    </span>
  </div>
);

const tableTitle = (table: SchemaTableDiff) =>
  table.kind === "renamed" && table.before !== null && table.after !== null
    ? `${tableName(table.before)} → ${tableName(table.after)}`
    : currentName(table);

const TableCard = ({
  table,
  onOpenTable,
}: {
  readonly table: SchemaTableDiff;
  readonly onOpenTable: SchemaDiffBodyProps["onOpenTable"];
}) => {
  const lines = tableLines(table);
  const title = tableTitle(table);
  const shortcut = commandShortcut("view.data");

  return (
    <section
      data-testid="schema-table"
      data-kind={table.kind}
      className="border-hairline rounded-row overflow-clip border"
    >
      <header className={cn("gap-row-x px-row-pad h-row flex items-center", HEADER_BG[table.kind])}>
        <span
          className={cn("min-w-0 flex-1 truncate font-mono text-caption", TEXT[table.kind])}
          title={title}
        >
          <span aria-hidden="true">{SIGN[table.kind]} </span>
          <span className="sr-only">{table.kind} </span>
          table {title}
        </span>
        {onOpenTable !== undefined && table.kind !== "removed" && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => onOpenTable(currentName(table))}
          >
            Open in Data
            {shortcut !== "" && <Kbd variant="plain">{shortcut}</Kbd>}
          </Button>
        )}
      </header>
      {lines.length > 0 && (
        <div className="px-row-pad py-gap flex flex-col gap-1">
          {lines.map((line) => (
            <Line key={line.key} line={line} />
          ))}
        </div>
      )}
    </section>
  );
};

const RowsCard = ({ tables }: { readonly tables: ReadonlyArray<SchemaTableDiff> }) => (
  <section
    data-testid="schema-rows"
    className="border-hairline rounded-row px-row-pad py-gap flex flex-col gap-1 border"
  >
    <span className="text-caption text-text-subtle">Rows</span>
    {tables.map((table) => {
      const split = rowsSplit(table.rows);
      const name = currentName(table);

      return (
        <div
          key={`${table.kind}:${name}`}
          data-testid="schema-rows-line"
          className="gap-row-x text-caption flex min-w-0 items-baseline"
        >
          <span className="text-text-strong max-w-[40%] shrink-0 truncate font-mono" title={name}>
            {name}
          </span>
          <span className="text-text-subtle tabular min-w-0 flex-1 truncate">
            {split === null ? rowsWording(table.rows) : `${rowsWording(table.rows)} · ${split}`}
          </span>
        </div>
      );
    })}
  </section>
);

const Notes = ({
  source,
  scope,
}: {
  readonly source: SchemaSourceDiff;
  readonly scope: string;
}) => {
  const notes = [baselineNote(source.baseline) ?? scope, source.truncated ? TRUNCATED_NOTE : null];

  return (
    <>
      {notes.map((note) =>
        note === null ? null : (
          <span key={note} className="text-caption text-text-subtle min-w-0 truncate" title={note}>
            {note}
          </span>
        )
      )}
    </>
  );
};

const Tables = ({ source, onOpenTable }: Omit<SchemaDiffBodyProps, "scope">) => {
  const [all, setAll] = useState(false);
  const shown = all ? source.tables : source.tables.slice(0, FOLD_AFTER);
  const more = source.tables.length - shown.length;

  return (
    <>
      {shown.map((table) => (
        <TableCard
          key={`${table.kind}:${tableTitle(table)}`}
          table={table}
          onOpenTable={onOpenTable}
        />
      ))}
      {more > 0 && (
        <Button variant="ghost" className="self-start" onClick={() => setAll(true)}>
          Show {more.toLocaleString("en-US")} more {more === 1 ? "table" : "tables"}
        </Button>
      )}
      {shown.length > 0 && <RowsCard tables={shown} />}
    </>
  );
};

const Waiting = ({ source }: { readonly source: SchemaSourceDiff }) =>
  source.status === "pending" ? (
    <p className="text-caption text-text-subtle" data-testid="schema-pending">
      Capturing schema…
    </p>
  ) : (
    <EmptyState
      icon={<PixelForkIcon size={24} />}
      title="Schema diff unavailable"
      fact={unavailableReason(source)}
    />
  );

export const SchemaDiffBody = ({ source, scope, onOpenTable }: SchemaDiffBodyProps) => (
  <div
    data-testid="schema-diff"
    data-status={source.status}
    className="px-panel pt-panel pb-section gap-gap flex min-h-0 flex-1 flex-col overflow-y-auto"
  >
    <header className="flex min-w-0 flex-col gap-0.5">
      <h2 className="text-heading-sm text-text-strong min-w-0 truncate" title={source.source.name}>
        Schema diff · {source.source.name}
      </h2>
      <Notes source={source} scope={scope} />
    </header>
    {source.status === "complete" ? (
      <Tables source={source} onOpenTable={onOpenTable} />
    ) : (
      <Waiting source={source} />
    )}
  </div>
);
