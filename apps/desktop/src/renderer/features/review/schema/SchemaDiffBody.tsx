/**
 * The Schema Diff body in Review's diff pane (Paper D4, DESIGN.md Data → In Review): a card
 * per table in the diff colours with its columns, indexes and constraints, then the rows card;
 * above them, where the comparison starts and what it may over- or under-say. Past
 * `FOLD_AFTER` tables the rest wait behind "Show N more tables".
 */
import type { SchemaSourceDiff, SchemaTableDiff } from "@polaris/protocol";
import { Badge, Button, cn, EmptyState, PixelForkIcon } from "@polaris/ui";
import { useState } from "react";
import { commandShortcut } from "../../../../shared/keymap.ts";
import type { TableRef } from "../../data/model/tabs.ts";
import {
  caveats,
  DETAILS_TRUNCATED_NOTE,
  ESTIMATE_TITLE,
  provenance,
  type ProvenanceContext,
  ROWS_FOOTNOTE,
  rowsLine,
  unavailableReason,
} from "./copy.ts";
import { tableLines } from "./lines.ts";
import { currentName, FOLD_AFTER, tableName } from "./model.ts";
import { SchemaLineRow, SIGN, TEXT } from "./SchemaLineRow.tsx";

export interface SchemaDiffBodyProps {
  readonly source: SchemaSourceDiff;
  /** "start → end of turn 7", "across this session". */
  readonly scope: string;
  /** Opens a table in Data mode; absent where Data can't be opened. */
  readonly onOpenTable?: ((table: TableRef) => void) | undefined;
  /** The Turn picked and its neighbours' numbers, to say where a carried baseline came from. */
  readonly turn?: ProvenanceContext["turn"];
  readonly turnNumber?: ProvenanceContext["turnNumber"];
  /** "Schema snapshots of older turns are no longer kept", when retention dropped some. */
  readonly pruned?: string | null | undefined;
  /** For "2 hours ago"; the clock when omitted. */
  readonly now?: number | undefined;
}

const HEADER_BG: Record<SchemaTableDiff["kind"], string> = {
  added: "bg-diff-added-bg",
  removed: "bg-diff-removed-bg",
  changed: "bg-git-modified/12",
  renamed: "bg-git-modified/12",
};

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
  const current = table.after ?? table.before;
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
        {table.detailsTruncated === true && (
          <Badge data-testid="schema-partial" title={DETAILS_TRUNCATED_NOTE}>
            partial
          </Badge>
        )}
        {onOpenTable !== undefined && table.kind !== "removed" && current !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={() => onOpenTable(current)}
            title={shortcut === "" ? undefined : `Data ${shortcut}`}
          >
            Open in Data
          </Button>
        )}
      </header>
      {(lines.length > 0 || table.detailsTruncated === true) && (
        <div className="px-row-pad py-gap flex flex-col gap-1">
          {lines.map((line) => (
            <SchemaLineRow key={line.key} line={line} />
          ))}
          {table.detailsTruncated === true && (
            <p className="text-caption text-text-subtle">{DETAILS_TRUNCATED_NOTE}</p>
          )}
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
      const name = currentName(table);
      const line = rowsLine(table.rows);

      return (
        <div
          key={`${table.kind}:${name}`}
          data-testid="schema-rows-line"
          data-rows={table.rows.kind}
          className="gap-row-x text-caption flex min-w-0 items-baseline"
        >
          <span className="text-text-strong max-w-[40%] shrink-0 truncate font-mono" title={name}>
            {name}
          </span>
          <span
            className="text-text-subtle tabular min-w-0 flex-1 truncate"
            title={table.rows.kind === "estimate" ? `${line}. ${ESTIMATE_TITLE}` : line}
          >
            {line}
          </span>
        </div>
      );
    })}
    <p data-testid="schema-rows-footnote" className="text-micro text-text-subtle pt-1">
      {ROWS_FOOTNOTE}
    </p>
  </section>
);

const Notes = ({
  source,
  context,
  pruned,
}: {
  readonly source: SchemaSourceDiff;
  readonly context: ProvenanceContext;
  readonly pruned: string | null;
}) => {
  const from = provenance(source, context);
  const notes = [...caveats(source), ...(pruned === null ? [] : [pruned])];

  return (
    <>
      <span
        data-testid="schema-provenance"
        className="text-caption text-text-subtle min-w-0 truncate"
        title={from.title ?? from.text}
      >
        {from.text}
      </span>
      {notes.length > 0 && (
        <ul data-testid="schema-caveats" className="flex min-w-0 flex-col gap-0.5 pt-1">
          {notes.map((note) => (
            <li key={note} className="text-caption text-text-default min-w-0">
              {note}
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

const Tables = ({ source, onOpenTable }: Pick<SchemaDiffBodyProps, "source" | "onOpenTable">) => {
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

export const SchemaDiffBody = ({
  source,
  scope,
  onOpenTable,
  turn,
  turnNumber,
  pruned = null,
  now = Date.now(),
}: SchemaDiffBodyProps) => (
  <div
    data-testid="schema-diff"
    data-status={source.status}
    className="px-panel pt-panel pb-section gap-gap flex min-h-0 flex-1 flex-col overflow-y-auto"
  >
    <header className="flex min-w-0 flex-col gap-0.5">
      <h2 className="text-heading-sm text-text-strong min-w-0 truncate" title={source.source.name}>
        Schema diff · {source.source.name}
      </h2>
      <Notes source={source} context={{ scope, turn, turnNumber, now }} pruned={pruned} />
    </header>
    {source.status === "complete" ? (
      <Tables source={source} onOpenTable={onOpenTable} />
    ) : (
      <Waiting source={source} />
    )}
  </div>
);
