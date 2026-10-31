/**
 * The SQL tab's scenes (U3): overdue invoices run with results (Paper D2), and a query naming
 * a table that isn't there, its message and position under the editor.
 */
import { dataSessionKey, dataTabsStore, openSqlTab } from "../../model/store.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { queueRun } from "../../sql/state.ts";
import { fixtureDataApi } from "../fixtureApi.ts";
import type { DataScene } from "./scene.ts";

const OVERDUE = `select *
from invoices
where status = 'overdue'`;

/** Opens a SQL tab on `app` and runs it once it mounts. */
const run = (sql: string) => (at: DataSessionKey) => {
  openSqlTab(sql, "app", at);
  const opened = dataTabsStore.getState().sessions[dataSessionKey(at)]?.active;

  if (opened != null) queueRun(at, opened);
};

const api = () => fixtureDataApi();

export const SQL_SCENES = {
  sql: { api, play: run(OVERDUE) },
  "sql-error": { api, play: run("select *\nfrom nowhere") },
} satisfies Record<string, DataScene>;
