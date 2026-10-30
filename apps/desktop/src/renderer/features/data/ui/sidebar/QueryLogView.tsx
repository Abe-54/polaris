/**
 * The sidebar's Query log (DESIGN.md, Data → Query Log): one row per Query, newest first, with
 * its author in the Harness hue or "You", Turn, source, SQL on one line, rows and time. A write
 * waiting on the user is the needs-you row; any row re-runs into a new SQL tab.
 */
import { cn, hueVar, PixelHandIcon } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { age } from "../../../../shell/copy.ts";
import { useNow } from "../../../../shell/useNow.ts";
import type { Loaded } from "../../data/hooks.tsx";
import { type LogLookups, type LogRow, logRows } from "../../model/queryLog.ts";
import { type DataSessionKey, openSqlTab } from "../../model/store.ts";
import type { QueryLogEntry } from "@polaris/protocol";

/** Two lines of text and the row's padding, per density (the virtualizer's guess). */
const ROW_HEIGHT = 46;

const Marker = ({ row }: { readonly row: LogRow }) => {
  if (row.state === "needs-you")
    return <PixelHandIcon size={10} className="text-needs-you" aria-label="Needs you" />;
  const { author } = row;

  if (author.kind === "user")
    return <span className="border-text-subtle size-1.5 rounded-full border" aria-label="You" />;

  return (
    <span
      className={cn(
        "size-1.5 rounded-full",
        author.kind === "outside" && "opacity-(--opacity-dimmed)"
      )}
      style={{
        background: author.harness === null ? "var(--color-text-subtle)" : hueVar(author.harness),
      }}
    />
  );
};

/** "Fix overdue totals · turn 12 · app": who ran it, in which Turn, against which source. */
const byline = (row: LogRow): string => {
  const { author } = row;

  if (author.kind === "user") return `You · ${row.source}`;

  if (author.kind === "outside") return `${author.title} · outside Polaris`;

  return [author.title, author.turn === null ? null : `turn ${author.turn}`, row.source]
    .filter((part) => part !== null)
    .join(" · ");
};

const Outcome = ({ row }: { readonly row: LogRow }) => {
  if (row.state === "needs-you")
    return <span className="text-needs-you-text shrink-0">needs you</span>;

  if (row.state === "failed")
    return (
      <span className="text-failed-text min-w-0 truncate" title={row.result}>
        failed
      </span>
    );

  return row.result === "" ? null : <span className="tabular shrink-0">{row.result}</span>;
};

const Row = ({ row, now, onOpen }: { row: LogRow; now: number; onOpen: (row: LogRow) => void }) => {
  const outside = row.author.kind === "outside";

  return (
    <button
      type="button"
      data-testid="data-log-row"
      data-state={row.state}
      onClick={() => onOpen(row)}
      title={outside && row.author.kind === "outside" ? row.author.command : row.entry.sql}
      className="hover:bg-fill-hover focus-visible:ring-starlight flex w-full cursor-default flex-col gap-0.5 rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="flex w-full items-center gap-2">
        <span className="flex w-2.5 shrink-0 justify-center">
          <Marker row={row} />
        </span>
        <span
          className={cn(
            "text-code-inline min-w-0 flex-1 truncate font-mono",
            outside ? "text-text-subtle" : "text-text-default"
          )}
        >
          {row.sql}
        </span>
        <span className="text-micro text-text-subtle tabular shrink-0">
          {age(row.entry.at, now)}
        </span>
      </span>
      <span className="text-caption text-text-subtle flex w-full items-center gap-1.5 pl-[18px]">
        <span className="min-w-0 truncate">{byline(row)}</span>
        {outside ? null : (
          <>
            <span className="flex-1" />
            <Outcome row={row} />
          </>
        )}
      </span>
    </button>
  );
};

export interface QueryLogViewProps {
  readonly at: DataSessionKey;
  readonly log: Loaded<ReadonlyArray<QueryLogEntry>>;
  readonly lookups: LogLookups;
}

export const QueryLogView = ({ at, log, lookups }: QueryLogViewProps) => {
  const now = useNow();
  const entries = log.status === "ready" ? log.value : null;

  const rows = useMemo(
    () => (entries === null ? [] : logRows(entries, lookups)),
    [entries, lookups]
  );

  const scroller = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  if (log.status === "loading")
    return <p className="text-caption text-text-subtle px-panel py-2">Loading the query log…</p>;

  if (log.status === "failed")
    return (
      <div className="px-panel flex flex-col gap-1 py-2" role="alert">
        <p className="text-label text-text-default">Couldn't load the query log</p>
        <p className="text-caption text-text-subtle">{log.error.message}</p>
      </div>
    );

  if (rows.length === 0)
    return (
      <p className="text-caption text-text-subtle px-panel py-2" data-testid="data-log-empty">
        No queries yet. Queries agents and you run against this checkout's data sources appear here.
      </p>
    );

  const open = (row: LogRow) => openSqlTab(row.entry.sql, row.source, at);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2.5" aria-label="Query log">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return row === undefined ? null : (
            <div
              key={row.id}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <Row row={row} now={now} onOpen={open} />
            </div>
          );
        })}
      </div>
    </div>
  );
};
