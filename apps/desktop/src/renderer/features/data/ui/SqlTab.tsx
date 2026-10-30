/** Placeholder: the SQL tab (run bar, editor with completion, results; DESIGN.md, Data) replaces this file. */
import type { DataTab } from "../model/tabs.ts";
import type { DataTabProps } from "./slots.ts";

type SqlTab = Extract<DataTab, { kind: "sql" }>;

export const sqlTabTitle = (tab: SqlTab) => tab.title;

export const SqlTabBody = ({ tab }: DataTabProps<SqlTab>) => (
  <pre data-testid="data-sql-tab" className="text-code text-text-default flex-1 p-4 font-mono">
    {tab.sql}
  </pre>
);
