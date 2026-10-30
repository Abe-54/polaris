/**
 * The Table tab (DESIGN.md, Data: Table tab; Paper D1): the filter well and the Data / Structure
 * toggle, then the grid of the table's rows (paged to the cap) or its structure. A foreign key
 * opens the table it points at, filtered to the row.
 */
import { TableDetail } from "@polaris/protocol";
import { EmptyState, PixelServerIcon, SegmentedControl } from "@polaris/ui";
import { useMemo, useState } from "react";
import { useDataSources, useDescribe } from "../data/hooks.tsx";
import type { GridColumn } from "../grid/columns.ts";
import { emptySelection } from "../grid/selection.ts";
import { cellOf, type DataValue } from "../grid/value.ts";
import { openTable } from "../model/store.ts";
import { type DataTab, tableTabId } from "../model/tabs.ts";
import type { DataTabProps } from "./slots.ts";
import { FilterWell } from "./table/FilterWell.tsx";
import { cleanFilter, keyFilter, tableSql } from "./table/sql.ts";
import { setTableView, type TableViewKind, useTableView } from "./table/state.ts";
import { Structure } from "./table/Structure.tsx";
import { TableData } from "./table/TableData.tsx";
import { usePages } from "./table/usePages.ts";

type TableTab = Extract<DataTab, { kind: "table" }>;

export const tableTabTitle = (tab: TableTab) => tab.table;

const VIEWS = [
  { value: "data", label: "Data" },
  { value: "structure", label: "Structure" },
] as const;

const Failed = ({ title, fact }: { readonly title: string; readonly fact: string }) => (
  <div className="grid flex-1 place-items-center" data-testid="data-table-failed">
    <EmptyState
      icon={<PixelServerIcon size={24} className="text-text-strong" />}
      title={title}
      fact={fact}
    />
  </div>
);

export const TableTabBody = ({ at, tab }: DataTabProps<TableTab>) => {
  const { filter, view } = useTableView(at, tab.id);
  const sources = useDataSources(at);
  const described = useDescribe(at, { source: tab.sourceId, table: tab.table });

  const engine =
    (sources.status === "ready"
      ? sources.value.find((s) => s.name === tab.sourceId)?.engine
      : undefined) ?? "postgres";

  const detail =
    described.status === "ready" && described.value instanceof TableDetail ? described.value : null;

  const where = cleanFilter(filter);
  const key = detail === null ? null : `${tab.sourceId}\u0000${tab.table}\u0000${where}`;

  const request = useMemo(() => {
    if (key === null || detail === null) return null;
    const orderBy = detail.columns.filter((c) => c.pk).map((c) => c.name);

    return {
      key,
      source: tab.sourceId,
      sql: (limit: number, offset: number) =>
        tableSql({ engine, table: tab.table, filter: where, orderBy, limit, offset }),
    };
  }, [key, detail, engine, tab.sourceId, tab.table, where]);

  const { pages, more } = usePages(at, request);
  const [selection, setSelection] = useState({ key, value: emptySelection });
  const current = selection.key === key ? selection.value : emptySelection;

  const columns = useMemo((): ReadonlyArray<GridColumn> => {
    const typed = detail?.columns ?? [];
    const shown = pages.columns ?? typed;

    return shown.map(({ name, type }) => {
      const fk = typed.find((c) => c.name === name)?.fk ?? null;

      return { name, type, fk: fk === null ? null : { table: fk.table, column: fk.column } };
    });
  }, [detail, pages.columns]);

  const openKey = (column: GridColumn, value: DataValue | undefined) => {
    const raw = cellOf(value).raw;

    if (column.fk == null || raw === null) return;
    openTable(tab.sourceId, column.fk.table, at);
    setTableView(at, tableTabId(tab.sourceId, column.fk.table), {
      filter: keyFilter(engine, column.fk.column, raw),
      view: "data",
    });
  };

  const body = () => {
    if (described.status === "failed")
      return <Failed title={`Couldn't read ${tab.table}`} fact={described.error.message} />;

    if (view === "structure")
      return detail === null ? null : (
        <Structure detail={detail} onOpenTable={(t) => openTable(tab.sourceId, t, at)} />
      );

    if (pages.status === "failed")
      return (
        <Failed title="The filter didn't run" fact={pages.error?.message ?? "The query failed"} />
      );

    return (
      <TableData
        at={at}
        source={tab.sourceId}
        from={where === "" ? tab.table : `${tab.table} where ${where}`}
        columns={columns}
        pages={pages}
        selection={current}
        onSelectionChange={(value) => setSelection({ key, value })}
        onMore={more}
        onForeignKey={openKey}
      />
    );
  };

  return (
    <div data-testid="data-table-tab" className="flex min-h-0 flex-1 flex-col">
      <div className="border-hairline flex h-12 shrink-0 items-center gap-2.5 border-b px-3">
        <FilterWell
          columns={columns}
          value={filter}
          onApply={(next) => setTableView(at, tab.id, { filter: next })}
        />
        <SegmentedControl<TableViewKind>
          aria-label="Show"
          options={VIEWS}
          value={view}
          onValueChange={(next) => setTableView(at, tab.id, { view: next })}
        />
      </div>
      {body()}
    </div>
  );
};
