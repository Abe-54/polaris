/** Placeholder: the Table tab (filter well, Data / Structure, the grid; DESIGN.md, Data) replaces this file. */
import type { DataTab } from "../model/tabs.ts";
import type { DataTabProps } from "./slots.ts";

type TableTab = Extract<DataTab, { kind: "table" }>;

export const tableTabTitle = (tab: TableTab) => tab.table;

export const TableTabBody = ({ tab }: DataTabProps<TableTab>) => (
  <div data-testid="data-table-tab" className="text-body text-text-subtle flex-1 p-4 font-mono">
    {tab.sourceId} · {tab.table}
  </div>
);
