/**
 * Sources (DESIGN.md, Data → Sidebar): the kicker, the virtualized tree ending in "Add data
 * source", or the empty state naming what was searched.
 */
import type { DataSource, QueryLogEntry } from "@polaris/protocol";
import { Button, cn, EmptyState, PixelServerIcon, PlusIcon } from "@polaris/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef } from "react";
import { useApp } from "../../../../shell/hooks.ts";
import { useDataSources, useTableChanges } from "../../data/hooks.tsx";
import { busyKey, busyTables, type LogLookups } from "../../model/queryLog.ts";
import { openSourceForm, toggleTreeRow, useSidebar } from "../../model/sidebar.ts";
import { type DataSessionKey, openTable } from "../../model/store.ts";
import { type DataTab, type TableRef, tableTabId } from "../../model/tabs.ts";
import { openSources, treeRows } from "../../model/tree.ts";
import { TreeRow } from "./TreeRow.tsx";
import { useSchemaTrees } from "./useSchemaTrees.ts";
import { useTreeFocus } from "./useTreeFocus.ts";

/** Tree-row heights per density step (DESIGN.md, Density), the virtualizer's first guess. */
/** The sidebar's list before it is measured: its width and a window's height. */
const INITIAL_RECT = { width: 246, height: 800 };

const ROW = { calm: 28, balanced: 24, compact: 22 } as const;

const NO_CHANGES = [] as const;

export interface SourcesViewProps {
  readonly at: DataSessionKey;
  readonly active: DataTab | null;
  readonly log: ReadonlyArray<QueryLogEntry>;
  readonly lookups: LogLookups;
  /** False while the Host is Reconnecting or Offline: adding a source waits for it. */
  readonly canAdd: boolean;
}

interface AddProps {
  readonly at: DataSessionKey;
  readonly canAdd: boolean;
}

const AddSource = ({ at, canAdd }: AddProps) => (
  <button
    type="button"
    disabled={!canAdd}
    data-testid="data-add-source"
    onClick={() => openSourceForm(at, { mode: "add" })}
    className="h-tree-row text-label text-text-subtle hover:text-text-default mt-1.5 flex w-full cursor-default items-center gap-2 rounded-[8px] pr-2.5 pl-2 text-left disabled:opacity-(--opacity-dimmed)"
  >
    <span className="flex w-3 shrink-0 justify-center">
      <PlusIcon size={12} />
    </span>
    Add data source
  </button>
);

/** Where discovery looked, named in the empty state ("what was searched"). */
const NoSources = ({ at, canAdd }: AddProps) => (
  <EmptyState
    data-testid="data-no-sources"
    className="px-panel py-8"
    icon={<PixelServerIcon size={24} className="text-text-strong" />}
    title="No data sources found"
    fact="Searched this checkout's .env files, framework config (Prisma, Drizzle, Rails, Django) and compose files"
    action={
      <Button
        variant="secondary"
        disabled={!canAdd}
        onClick={() => openSourceForm(at, { mode: "add" })}
      >
        Add data source
      </Button>
    }
  />
);

/** The file every source was found in, shown by the kicker; none when they differ. */
const sharedFile = (sources: ReadonlyArray<DataSource>) => {
  const files = new Set(sources.map((s) => s.foundIn.file ?? s.foundIn.kind));

  return files.size === 1 ? [...files][0] : null;
};

const Tree = ({
  at,
  active,
  log,
  lookups,
  canAdd,
  sources,
}: SourcesViewProps & { readonly sources: ReadonlyArray<DataSource> }) => {
  const density = useApp((s) => s.density);
  const { toggled } = useSidebar(at);
  const changesLoad = useTableChanges(at);
  const changes = changesLoad.status === "ready" ? changesLoad.value : NO_CHANGES;
  const names = openSources({ sources, changes, toggled });

  const trees = useSchemaTrees(
    at,
    sources.filter((s) => names.includes(s.name))
  );

  const rows = useMemo(
    () => treeRows({ sources, trees, changes, toggled }),
    [sources, trees, changes, toggled]
  );

  const busy = useMemo(() => busyTables(log, lookups), [log, lookups]);
  const scroller = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length + 1,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW[density],
    // The first paint, before the list is measured (and in tests, where nothing is).
    initialRect: INITIAL_RECT,
    overscan: 12,
  });

  const selected =
    active?.kind === "table"
      ? (row: { source: string; ref: TableRef }) => tableTabId(row.source, row.ref) === active.id
      : () => false;

  const focus = useTreeFocus({
    rows,
    selected: rows.find((r) => r.kind === "table" && selected(r))?.key ?? null,
    scroller,
    virtualizer,
    onToggle: (row) => "open" in row && toggleTreeRow(at, row.key, row.open),
  });

  return (
    <div
      ref={scroller}
      className="min-h-0 flex-1 overflow-y-auto px-2.5"
      role="tree"
      aria-label="Data sources"
      onKeyDown={focus.onKeyDown}
      onFocus={focus.onFocus}
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];

          return (
            <div
              key={row?.key ?? "add"}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn(
                "absolute top-0 left-0 w-full",
                row?.kind === "source" && item.index > 0 && "pt-1.5"
              )}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row === undefined ? (
                <AddSource at={at} canAdd={canAdd} />
              ) : (
                <TreeRow
                  row={row}
                  selected={row.kind === "table" && selected(row)}
                  tabStop={row.key === focus.tabStop}
                  busy={
                    row.kind === "table"
                      ? (busy.get(busyKey(row.source, row.summary.name)) ?? null)
                      : null
                  }
                  onToggle={(key, open) => toggleTreeRow(at, key, open)}
                  onOpenTable={(source, ref, title) => openTable(source, ref, at, title)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const SourcesView = (props: SourcesViewProps) => {
  const sources = useDataSources(props.at);

  if (sources.status === "loading")
    return <p className="text-caption text-text-subtle px-panel py-2">Looking for data sources…</p>;

  if (sources.status === "failed")
    return (
      <div
        className="px-panel flex flex-col gap-1 py-2"
        role="alert"
        data-testid="data-sources-failed"
      >
        <p className="text-label text-text-default">Couldn't load data sources</p>
        <p className="text-caption text-text-subtle">{sources.error.message}</p>
      </div>
    );

  if (sources.value.length === 0) return <NoSources at={props.at} canAdd={props.canAdd} />;
  const file = sharedFile(sources.value);

  return (
    <>
      <div className="flex h-6 shrink-0 items-center justify-between gap-2 pr-5 pl-4.5">
        <span className="text-micro text-text-subtle font-mono font-medium tracking-[0.06em] uppercase">
          Data sources · {sources.value.length}
        </span>
        {file === null ? null : (
          <span className="text-micro text-text-faint min-w-0 truncate font-mono">{file}</span>
        )}
      </div>
      <Tree {...props} sources={sources.value} />
    </>
  );
};
