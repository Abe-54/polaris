/**
 * The SQL tab's scenes (U3): overdue invoices run with results (Paper D2), a query naming a table
 * that isn't there, and "Fix overdue totals" Working over invoices, its strip above the grid.
 */
import { AgentSession, TurnId } from "@polaris/protocol";
import type { AppState } from "../../../../store/store.ts";
import { dataSessionKey, dataTabsStore, openSqlTab, openTable } from "../../model/store.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { queueRun } from "../../sql/state.ts";
import { fixtureDataApi } from "../fixtureApi.ts";
import { FIXTURE_NOW, FIXTURE_SESSIONS } from "../fixtures.ts";
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

/** Fix overdue totals mid-Turn: Working on turn 12, which the fixture Query Log's reads name. */
const working = (base: AppState): AppState => {
  const hostModels = Object.fromEntries(
    Object.entries(base.hostModels).map(([key, model]) => {
      const sessions = new Map(model.sessions);
      const entry = sessions.get(FIXTURE_SESSIONS.overdue.id);

      if (entry !== undefined)
        sessions.set(FIXTURE_SESSIONS.overdue.id, {
          ...entry,
          session: new AgentSession({
            ...entry.session,
            state: "working",
            currentUserTurn: {
              turnId: TurnId.make("turn-12"),
              number: 12,
              startedAt: new Date(FIXTURE_NOW - 125 * 60_000).toISOString(),
            },
          }),
        });

      return [key, { ...model, sessions }];
    })
  );

  return { ...base, hostModels };
};

const api = () => fixtureDataApi();

export const SQL_SCENES = {
  sql: { api, play: run(OVERDUE) },
  "sql-error": { api, play: run("select *\nfrom nowhere") },
  working: {
    api,
    state: working,
    play: (at) => openTable("app", { schema: "public", name: "invoices" }, at),
  },
} satisfies Record<string, DataScene>;
