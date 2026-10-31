/**
 * The Table tab (DESIGN.md, Data: Table tab; Paper D1): the filter well and the Data / Structure
 * toggle, then the grid of the table's rows (paged to the cap) or its structure. A foreign key
 * opens the table it points at, filtered to the row; Back restores the filter it replaced. Cells edit
 * in place and stage until Commit ⌘S (table/edits).
 */
import { type DataSource, TableDetail } from "@polaris/protocol";
import {
  Button,
  ChevronLeftIcon,
  EmptyState,
  PixelServerIcon,
  SegmentedControl,
  showToast,
} from "@polaris/ui";
import { useEffect, useMemo, useState } from "react";
import { useDataSources, useDescribe } from "../data/hooks.tsx";
import type { GridColumn } from "../grid/columns.ts";
import { emptySelection } from "../grid/selection.ts";
import type { DataValue } from "../grid/value.ts";
import { openTable } from "../model/store.ts";
import { type DataTab, type TableRef, tableTabId } from "../model/tabs.ts";
import type { DataTabProps } from "./slots.ts";
import { FilterWell } from "./table/FilterWell.tsx";
import {
  cleanFilter,
  type Engine,
  filterProblem,
  keyFilter,
  qualifiedName,
  tableSql,
} from "./table/sql.ts";
import {
  filterBack,
  followFilter,
  setTableView,
  type TableViewKind,
  useTableView,
} from "./table/state.ts";
import { Structure } from "./table/Structure.tsx";
import { TableData } from "./table/TableData.tsx";
import { forgetWritten } from "./table/edits/store.ts";
import { useTableEdits } from "./table/edits/useTableEdits.ts";
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

/** The name `data.describe` resolves: Postgres's regclass, quoted per part; MySQL's in its database. */
export const describeName = (engine: Engine, ref: TableRef) =>
  engine === "mysql" ? ref.name : qualifiedName(engine, ref);

/**
 * The source and its engine once the sources are read, so the table is described once, in its
 * own quoting. The engine defaults to Postgres when the source isn't listed.
 */
interface ShownSource {
  readonly engine: Engine | null;
  readonly source: DataSource | null;
}

const useSource = (at: DataTabProps<TableTab>["at"], name: string): ShownSource => {
  const sources = useDataSources(at);

  if (sources.status === "loading") return { engine: null, source: null };

  const source =
    sources.status === "ready" ? sources.value.find((s) => s.name === name) : undefined;

  return { engine: source?.engine ?? "postgres", source: source ?? null };
};

/** Why a foreign key wasn't followed, said where the user is looking. */
const cantFollow = (reason: string) =>
  showToast({
    source: "starlight",
    icon: <PixelServerIcon size={16} />,
    title: "This key can't be followed",
    message: reason,
  });

export const TableTabBody = ({ at, tab }: DataTabProps<TableTab>) => {
  const { filter, view, back } = useTableView(at, tab.id);
  const { engine: known, source } = useSource(at, tab.sourceId);
  const engine = known ?? "postgres";

  const described = useDescribe(
    at,
    known === null ? null : { source: tab.sourceId, table: describeName(known, tab.ref) }
  );

  const detail =
    described.status === "ready" && described.value instanceof TableDetail ? described.value : null;

  const where = cleanFilter(filter);
  const problem = filterProblem(engine, where);
  const key = detail === null || problem !== null ? null : `${tab.id}\u0000${where}`;

  const request = useMemo(() => {
    if (key === null || detail === null) return null;
    const orderBy = detail.columns.filter((c) => c.pk).map((c) => c.name);

    return {
      key,
      source: tab.sourceId,
      sql: (limit: number, offset: number) =>
        tableSql({ engine, table: tab.ref, filter: where, orderBy, limit, offset }),
    };
  }, [key, detail, engine, tab.sourceId, tab.ref, where]);

  const { pages, more } = usePages(at, request);
  const [selection, setSelection] = useState({ key, value: emptySelection });
  const current = selection.key === key ? selection.value : emptySelection;

  // Rows read again hold what a commit wrote; the written overlay only bridges until then.
  const { hostKey, sessionId } = at;

  useEffect(() => forgetWritten({ hostKey, sessionId }, tab.id), [hostKey, sessionId, tab.id, key]);

  const columns = useMemo((): ReadonlyArray<GridColumn> => {
    const typed = detail?.columns ?? [];
    const shown = pages.columns ?? typed;

    return shown.map(({ name, type }) => {
      const fk = typed.find((c) => c.name === name)?.fk ?? null;

      return { name, type, fk };
    });
  }, [detail, pages.columns]);

  const names = useMemo(() => columns.map((c) => c.name), [columns]);

  const edit = useTableEdits({
    at,
    tabId: tab.id,
    table: tab.ref,
    detail,
    source,
    columns: names,
    rows: pages.rows,
  });

  /** Another schema's table keeps its schema in the title; so does every table where this one does. */
  const titleOf = (ref: TableRef) =>
    ref.schema === tab.ref.schema && tab.table === tab.ref.name
      ? ref.name
      : `${ref.schema}.${ref.name}`;

  const openRef = (ref: TableRef) => openTable(tab.sourceId, ref, at, titleOf(ref));

  const openKey = (column: GridColumn, value: DataValue | undefined) => {
    if (column.fk == null) return;
    const ref = { schema: column.fk.schema, name: column.fk.table };
    const followed = keyFilter(engine, column.fk.column, value);

    if ("reason" in followed) return cantFollow(followed.reason);
    openRef(ref);
    followFilter(at, tableTabId(tab.sourceId, ref), followed.filter);
  };

  const body = () => {
    if (described.status === "failed")
      return <Failed title={`Couldn't read ${tab.table}`} fact={described.error.message} />;

    if (view === "structure")
      return detail === null ? null : <Structure detail={detail} onOpenTable={openRef} />;

    if (problem !== null) return <Failed title="The filter can't run" fact={problem} />;

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
        edit={edit}
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
        {back.length === 0 ? null : (
          <Button
            size="sm"
            variant="ghost"
            data-testid="data-filter-back"
            title={`Back to ${back.at(-1) === "" ? "every row" : `WHERE ${back.at(-1)}`}`}
            onClick={() => filterBack(at, tab.id)}
          >
            <ChevronLeftIcon size={16} />
            Back
          </Button>
        )}
        <FilterWell
          engine={engine}
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
