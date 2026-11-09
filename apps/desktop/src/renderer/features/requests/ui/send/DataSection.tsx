/**
 * DATA (DESIGN.md, Requests → Send pane): the tables the send's trace touched, table-level only
 * (rows are ENG-812): "wrote" in tan, "read" plain, "write failed" on an error span. "Open in
 * Data ⌘4" and "Open statement" act on the selected table, in the Data Source its span ran against.
 */
import type { DataSource, TraceDetail } from "@polaris/protocol";
import { cn } from "@polaris/ui";
import { useState } from "react";
import { commandShortcut } from "../../../../../shared/keymap.ts";
import { useDataSources } from "../../../data/data/hooks.tsx";
import { spanDataSource } from "../../../traces/model/span/dataSource.ts";
import { KICKER, Pill } from "../../../traces/ui/span/parts.tsx";
import type { RequestsSessionKey } from "../../model/session.ts";
import { statementOf, type TableTouch, type TouchedTable, touchedTables } from "./model.ts";
import { useOpenElsewhere } from "./useOpenElsewhere.ts";

const TOUCH_CLASS: Record<TableTouch, string> = {
  wrote: "text-git-modified-text",
  read: "text-text-subtle",
  "write failed": "text-severity-critical-text",
  "read failed": "text-severity-critical-text",
};

const tableName = (t: TouchedTable) =>
  t.table.schema === null ? t.table.name : `${t.table.schema}.${t.table.name}`;

const Header = ({ note }: { readonly note?: string }) => (
  <div className="px-panel flex items-baseline gap-2 pt-3 pb-1.5">
    <h3 className={cn(KICKER, "text-text-subtle")}>Data</h3>
    {note === undefined ? null : (
      <span className="text-caption text-text-faint" data-testid="send-data-note">
        {note}
      </span>
    )}
  </div>
);

const Actions = ({
  at,
  detail,
  table,
}: {
  readonly at: RequestsSessionKey;
  readonly detail: TraceDetail;
  readonly table: TouchedTable;
}) => {
  const listed = useDataSources(at);
  const open = useOpenElsewhere(at);
  const span = detail.spans.find((s) => s.id === table.spanId);
  const sql = span === undefined ? null : statementOf(span.attributes);

  const source: DataSource | null =
    listed.status !== "ready" || span === undefined
      ? null
      : spanDataSource(span.attributes, listed.value);

  if (source === null)
    return (
      <p className="text-caption text-text-faint px-panel pt-1.5" data-testid="send-data-no-source">
        {listed.status === "loading"
          ? "Reading data sources"
          : "No data source in this checkout matches this database"}
      </p>
    );

  return (
    <div className="px-panel flex flex-wrap items-center gap-2 pt-2">
      <Pill
        onClick={() => open.table(source, table.table)}
        hint={commandShortcut("view.data")}
        title={`Open ${tableName(table)} in ${source.name}`}
        testId="send-open-data"
      >
        Open in Data
      </Pill>
      {sql === null ? null : (
        <Pill
          onClick={() => open.statement(source, sql)}
          hint={undefined}
          title={sql}
          testId="send-open-statement"
        >
          Open statement
        </Pill>
      )}
    </div>
  );
};

export const DataSection = ({
  at,
  detail,
}: {
  readonly at: RequestsSessionKey;
  readonly detail: TraceDetail;
}) => {
  const tables = touchedTables(detail);
  const [picked, setPicked] = useState<string | null>(null);

  if (tables.length === 0)
    return (
      <section aria-label="Data" className="border-hairline shrink-0 border-t pb-3">
        <Header note="Nothing to show without database spans." />
      </section>
    );
  const selected = tables.find((t) => t.key === picked) ?? tables[0];

  return (
    <section aria-label="Data" className="border-hairline shrink-0 border-t pb-3">
      <Header />
      <div role="radiogroup" aria-label="Tables" data-testid="send-data">
        {tables.map((t) => (
          <button
            key={t.key}
            type="button"
            role="radio"
            aria-checked={t === selected}
            onClick={() => setPicked(t.key)}
            data-testid="send-data-table"
            className={cn(
              "hover:bg-fill-hover focus-visible:ring-starlight px-panel flex h-[22px] w-full cursor-default items-center gap-2 text-left outline-none focus-visible:ring-2",
              t === selected && "bg-fill-selected"
            )}
          >
            <span className="text-code-inline text-text-default min-w-0 flex-1 truncate font-mono">
              {tableName(t)}
            </span>
            {t.statements > 1 ? (
              <span className="text-micro text-text-faint shrink-0 font-mono">{`×${t.statements}`}</span>
            ) : null}
            <span className={cn("text-caption w-[84px] shrink-0 text-right", TOUCH_CLASS[t.touch])}>
              {t.touch}
            </span>
          </button>
        ))}
      </div>
      {selected === undefined ? null : <Actions at={at} detail={detail} table={selected} />}
    </section>
  );
};
