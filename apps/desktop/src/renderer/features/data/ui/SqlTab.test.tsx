import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { type DataValue, SessionId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import { type CommandRegistry, createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { onDraftChange } from "../../session/state.ts";
import type { DataApi, QueryInput } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import type { DataTab } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { SqlTabBody } from "./SqlTab.tsx";

afterEach(cleanup);

const at = { hostKey: "local", sessionId: SessionId.make("s-overdue-totals") };

let next = 0;

const sqlTab = (
  sql: string,
  sourceId = "app",
  params: ReadonlyArray<DataValue> = []
): Extract<DataTab, { kind: "sql" }> => ({
  kind: "sql",
  id: `sql-test-${++next}`,
  sourceId,
  sql,
  params,
  title: `Query ${next}`,
});

const mount = (
  tab: Extract<DataTab, { kind: "sql" }>,
  api: DataApi = fixtureDataApi()
): CommandRegistry => {
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));
  const commands = createCommandRegistry({ platform: "mac" });

  render(
    <AppProvider
      value={{
        connection: {
          store,
          openSession: () => () => undefined,
          setDensity: () => undefined,
          setAppearance: () => undefined,
        },
        navigation: createNavigation({ app: store, storage: null }),
        commands,
      }}
    >
      <TooltipProvider>
        <DataLayer api={api}>
          <SqlTabBody at={at} tab={tab} />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return commands;
};

/** Run, once the sources have arrived and the button is enabled. */
const run = async () => {
  await waitFor(() =>
    expect(screen.getByTestId("data-sql-run").hasAttribute("disabled")).toBe(false)
  );
  fireEvent.click(screen.getByTestId("data-sql-run"));
};

test("the run bar names the source and its loaded schema", async () => {
  mount(sqlTab("select 1"));

  await waitFor(() => expect(screen.getByTestId("data-sql-source").textContent).toContain("app"));
  expect(screen.getByTestId("data-sql-source").textContent).toContain("postgres · local");
  await waitFor(() =>
    expect(screen.getByTestId("data-sql-schema").textContent).toMatch(
      /^Schema loaded \d+[smh] ago · 7 tables$/
    )
  );
});

test("Run shows the rows; ⌘L and the button add them to the shown session's draft", async () => {
  const commands = mount(sqlTab("select * from currencies"));
  const drafts: Array<string> = [];
  const stop = onDraftChange((_key, draft) => drafts.push(draft));

  await run();
  await waitFor(() => expect(screen.getByTestId("data-sql-results")).not.toBeNull());

  expect(screen.getByTestId("data-sql-add-rows").textContent).toContain(
    "Add 4 rows to agent session"
  );
  expect(commands.run("data.addRowsToSession")).toBe(true);
  expect(drafts.at(-1)).toContain("4 rows from `app` · `select * from currencies`:");
  expect(drafts.at(-1)).toContain("JPY,Yen,0");
  stop();
});

test("a database error shows its message and where it points", async () => {
  mount(sqlTab("select total from nowhere"));

  await run();
  const error = await screen.findByTestId("data-sql-error");

  expect(error.textContent).toContain('relation "nowhere" does not exist');
  expect(error.textContent).toContain("Line 1, column 19");
});

test("with no rows to add, ⌘L is left to the composer", async () => {
  const commands = mount(sqlTab("select * from invoices where status = 'nope'"));

  await run();
  await waitFor(() => expect(screen.getByTestId("data-sql-results")).not.toBeNull());

  expect(commands.enabled("data.addRowsToSession")).toBe(false);
});

test("a re-run's params show in the run bar and are bound on Run, until unbound", async () => {
  const api = fixtureDataApi();
  const sent: Array<QueryInput> = [];
  const sql = "select * from invoices where customer_id = $1 and status = $2";

  mount(sqlTab(sql, "app", ["c-42", "overdue"]), {
    ...api,
    query: (at, input) => {
      sent.push(input);

      return api.query(at, input);
    },
  });

  expect(screen.getByTestId("data-sql-params").textContent).toBe("$1 = c-42 · $2 = overdue");
  await run();
  await waitFor(() => expect(sent).toHaveLength(1));
  fireEvent.click(screen.getByTestId("data-sql-unbind"));
  await run();
  await waitFor(() => expect(sent).toHaveLength(2));

  expect(sent.map((input) => input.params)).toEqual([["c-42", "overdue"], undefined]);
  expect(screen.queryByTestId("data-sql-params")).toBeNull();
});
