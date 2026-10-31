/**
 * The Query Log drawer under the grid (DESIGN.md, Data → Query Log; Paper D1): one row per Query,
 * scoped to the open table or source, the needs-you row marked, and any row re-runs in a SQL tab.
 */
import type { DataSource, QueryLogEntry } from "@polaris/protocol";
import {
  ChevronDownIcon,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  hueVar,
  Kicker,
} from "@polaris/ui";
import { useMemo, useState } from "react";
import { age } from "../../../shell/copy.ts";
import { useNow } from "../../../shell/useNow.ts";
import { useDataSources, useQueryLog } from "../data/hooks.tsx";
import {
  authorText,
  drawerKicker,
  type LogRow,
  type LogScope,
  resultText,
  runsOnOpen,
  scopedRows,
} from "../model/queryLog.ts";
import { type DataSessionKey, dataSessionKey, dataTabsStore, openSqlTab } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { queueRun, useSqlSource } from "../sql/state.ts";
import { useLogLookups } from "./sidebar/useLogLookups.ts";
import type { DataSlotProps } from "./slots.ts";

/** "This ran on app, which is gone or renamed. Choose a data source to run it." */
export const goneSourceNotice = (name: string) =>
  `This ran on ${name}, which is gone or renamed. Choose a data source to run it.`;

/**
 * Opens the query in a new SQL tab on the source it ran on, found by id, running it when it's
 * a plain read. A gone or renamed source opens with no source, not running, and says why.
 */
export const rerunInSqlTab = (
  at: DataSessionKey,
  entry: QueryLogEntry,
  sources: ReadonlyArray<DataSource> | null
) => {
  const source = sources?.find((s) => s.id === entry.source.id);

  // Before the sources are listed, it opens with none chosen and says nothing yet.
  if (source === undefined) {
    openSqlTab(
      entry.sql,
      "",
      at,
      sources === null ? undefined : goneSourceNotice(entry.source.name)
    );

    return;
  }

  openSqlTab(entry.sql, source.name, at);
  const opened = dataTabsStore.getState().sessions[dataSessionKey(at)]?.active;

  if (opened != null && runsOnOpen(entry.sql)) queueRun(at, opened);
};

const NONE: ReadonlyArray<QueryLogEntry> = [];

/** "all", "you", or one Agent Session's id. */
type Filter = string;

const sessionOf = (row: LogRow) =>
  row.entry.author.kind === "user" ? null : row.entry.author.sessionId;

const matches = (row: LogRow, filter: Filter) => {
  if (filter === "all") return true;

  if (filter === "you") return row.author.kind === "user";

  return sessionOf(row) === filter;
};

const Dot = ({ row }: { readonly row: LogRow }) => {
  const { author } = row;

  if (author.kind === "user" || author.harness === null)
    return (
      <span aria-hidden="true" className="border-text-subtle size-2 shrink-0 rounded-full border" />
    );

  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        author.kind === "outside" && "opacity-(--opacity-dimmed)"
      )}
      style={{ backgroundColor: hueVar(author.harness) }}
    />
  );
};

const Row = ({ row, now, onRun }: { row: LogRow; now: number; onRun: () => void }) => (
  <li>
    <button
      type="button"
      onClick={onRun}
      data-testid="data-query-log-row"
      data-status={row.state}
      title={row.entry.error ?? row.entry.sql}
      className="group/row hover:bg-fill-hover focus-visible:outline-starlight flex h-(--spacing-row) w-full cursor-default items-center gap-3 rounded-[8px] px-2 text-left focus-visible:outline-2"
    >
      <Dot row={row} />
      <span
        className={cn(
          "text-code min-w-0 flex-1 truncate font-mono",
          row.author.kind === "outside" ? "text-text-subtle" : "text-text-default"
        )}
      >
        {row.author.kind === "outside" ? row.author.command : row.sql}
      </span>
      <span
        className={cn(
          "text-caption w-56 shrink-0 truncate",
          row.state === "needs-you" ? "text-needs-you-text" : "text-text-subtle"
        )}
      >
        {authorText(row)}
      </span>
      <span
        className={cn(
          "text-caption tabular w-16 shrink-0 text-right font-mono",
          row.state === "failed" ? "text-failed-text" : "text-text-subtle"
        )}
      >
        {resultText(row)}
      </span>
      <span className="text-caption text-text-faint tabular w-10 shrink-0 text-right font-mono">
        <span className="group-hover/row:hidden group-focus-visible/row:hidden">
          {age(row.entry.at, now)}
        </span>
        <span className="text-text-strong hidden group-hover/row:inline group-focus-visible/row:inline">
          Run
        </span>
      </span>
    </button>
  </li>
);

const FilterMenu = ({
  rows,
  filter,
  onFilter,
}: {
  rows: ReadonlyArray<LogRow>;
  filter: Filter;
  onFilter: (filter: Filter) => void;
}) => {
  const sessions = new Map<string, string>([
    ["all", "All sessions"],
    ["you", "You"],
  ]);

  for (const row of rows) {
    const id = sessionOf(row);

    if (id !== null && row.author.kind !== "user") sessions.set(id, row.author.title);
  }

  const label = sessions.get(filter) ?? "All sessions";
  const agents = [...sessions].filter(([id]) => id !== "all" && id !== "you");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="text-caption text-text-subtle hover:text-text-default flex items-center gap-1 rounded-full px-2 py-1">
        {label}
        <ChevronDownIcon size={12} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onFilter("all")}>All sessions</DropdownMenuItem>
        {agents.map(([id, title]) => (
          <DropdownMenuItem key={id} onSelect={() => onFilter(id)}>
            {title}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem onSelect={() => onFilter("you")}>You</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const scopeOf = (active: DataTab | null, sqlSource: string | null): LogScope | null => {
  if (active === null) return null;

  if (active.kind === "table") return { source: active.sourceId, table: active.table };

  const source = sqlSource ?? active.sourceId;

  // A SQL tab with no source chosen shows every Query.
  return source === "" ? null : { source };
};

export const QueryLogDrawer = ({ at, hostKey, active }: DataSlotProps) => {
  const log = useQueryLog(at);
  const sources = useDataSources(at);
  const listed = sources.status === "ready" ? sources.value : null;
  const lookups = useLogLookups(hostKey);
  const sqlSource = useSqlSource(at, active);
  const scope = useMemo(() => scopeOf(active, sqlSource), [active, sqlSource]);
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState(true);
  const entries = log.status === "ready" ? log.value : NONE;
  const rows = useMemo(() => scopedRows(entries, lookups, scope), [entries, lookups, scope]);
  const shown = rows.filter((row) => matches(row, filter));

  return (
    <section
      aria-label="Query log"
      data-testid="data-query-log"
      className="border-hairline flex shrink-0 flex-col border-t"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 text-left"
        >
          <Kicker className="truncate">{drawerKicker(scope, shown.length)}</Kicker>
        </button>
        {open ? <FilterMenu rows={rows} filter={filter} onFilter={setFilter} /> : null}
      </header>
      {!open ? null : log.status === "failed" ? (
        <p className="text-caption text-text-subtle px-4 pb-3">{`Couldn't read the query log: ${log.error.message}`}</p>
      ) : shown.length === 0 ? (
        <p className="text-caption text-text-subtle px-4 pb-3">
          {log.status === "loading" ? "Reading the query log…" : "No queries here yet"}
        </p>
      ) : (
        <ul className="flex max-h-[calc(var(--spacing-row)*5+8px)] flex-col overflow-y-auto px-2 pb-2">
          {shown.map((row) => (
            <Row
              key={row.entry.id}
              row={row}
              now={now}
              onRun={() => rerunInSqlTab(at, row.entry, listed)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
