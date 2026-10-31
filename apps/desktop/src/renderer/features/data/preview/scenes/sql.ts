/**
 * The SQL tab's scenes (U3): overdue invoices run with results (Paper D2), a query naming a table
 * that isn't there, one still running, a re-run whose source is gone, and "Fix overdue totals"
 * Working over invoices, its strip above the grid, reading or waiting to change it.
 */
import { AgentSession, QueryLogEntry, TurnId } from "@polaris/protocol";
import type { AppState } from "../../../../store/store.ts";
import { dataSessionKey, dataTabsStore, openSqlTab, openTable } from "../../model/store.ts";
import type { DataSessionKey } from "../../model/store.ts";
import { queueRun } from "../../sql/state.ts";
import { fixtureDataApi } from "../fixtureApi.ts";
import { goneSourceNotice } from "../../ui/QueryLogDrawer.tsx";
import { FIXTURE_NOW, FIXTURE_QUERY_LOG, FIXTURE_SESSIONS } from "../fixtures.ts";
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

/** The fixture Query Log plus one agent query on invoices still in flight. */
const inFlight = (sql: string, state: "running" | "waiting-approval") => () =>
  fixtureDataApi({
    queryLog: [
      ...FIXTURE_QUERY_LOG,
      new QueryLogEntry({
        id: "q-in-flight",
        checkout: "/Users/lucas/code/ledger.worktrees/overdue-totals",
        source: { id: "src-app", name: "app" },
        sql,
        author: {
          kind: "agent",
          sessionId: FIXTURE_SESSIONS.overdue.id,
          turn: TurnId.make("turn-12"),
        },
        tool: "data_query",
        state,
        at: new Date(FIXTURE_NOW).toISOString(),
      }),
    ],
  });

/** A Host whose queries never finish, so Cancel shows. */
const hanging = () => ({
  ...fixtureDataApi(),
  queryStream: () => () => undefined,
});

export const SQL_SCENES = {
  sql: { api, play: run(OVERDUE) },
  "sql-error": { api, play: run("select *\nfrom nowhere") },
  "sql-running": { api: hanging, play: run(OVERDUE) },
  "sql-gone": {
    api,
    play: (at) => openSqlTab(OVERDUE, "", at, goneSourceNotice("app-before-rename")),
  },
  working: {
    api: inFlight("select * from invoices where status = 'overdue'", "running"),
    state: working,
    play: (at) => openTable("app", "invoices", at),
  },
  "working-write": {
    api: inFlight("update invoices set status = 'paid' where id = $1", "waiting-approval"),
    state: working,
    play: (at) => openTable("app", "invoices", at),
  },
} satisfies Record<string, DataScene>;
