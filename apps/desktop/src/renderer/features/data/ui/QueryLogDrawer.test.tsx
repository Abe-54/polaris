import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { DataLayer } from "../data/hooks.tsx";
import { dataSessionKey, dataTabsStore } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { takeQueuedRun } from "../sql/state.ts";
import { QueryLogDrawer } from "./QueryLogDrawer.tsx";

afterEach(cleanup);

let sessions = 0;

const mount = () => {
  const at = { hostKey: "local", sessionId: SessionId.make(`s-drawer-${++sessions}`) };
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));

  const invoices: DataTab = {
    kind: "table",
    id: "t-invoices",
    sourceId: "app",
    table: "invoices",
    ref: { schema: "public", name: "invoices" },
  };

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
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <TooltipProvider>
        <DataLayer api={fixtureDataApi()}>
          <QueryLogDrawer at={at} hostKey="local" workspaceId="w-ledger" active={invoices} />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return at;
};

const row = async (sql: string) => {
  const rows = await screen.findAllByTestId("data-query-log-row");
  const found = rows.find((r) => r.textContent?.includes(sql) === true);

  if (found === undefined) throw new Error(`no row for ${sql}`);

  return found;
};

const opened = (at: ReturnType<typeof mount>) => {
  const tabs = dataTabsStore.getState().sessions[dataSessionKey(at)];

  return tabs?.tabs.find((t) => t.id === tabs.active);
};

test("scoped to the open table, with the pending write first and marked", async () => {
  mount();

  const rows = await screen.findAllByTestId("data-query-log-row");

  expect(rows[0]?.dataset["status"]).toBe("needs-you");
  expect(rows.some((r) => r.textContent?.includes("invoice_items") === true)).toBe(false);
  expect(screen.getByTestId("data-query-log").textContent).toContain(
    `Query log · invoices · ${rows.length}`
  );
});

test("a read re-runs in a new SQL tab on its source", async () => {
  const at = mount();

  fireEvent.click(await row("select * from invoices where currency is null"));

  const tab = opened(at);

  expect(tab).toMatchObject({
    kind: "sql",
    sourceId: "app",
    sql: "select * from invoices where currency is null",
  });
  expect(tab !== undefined && takeQueuedRun(at, tab.id)).toBe(true);
});

test("a write opens in a SQL tab without running", async () => {
  const at = mount();

  fireEvent.click(await row("update invoices set currency"));

  const tab = opened(at);

  expect(tab).toMatchObject({
    kind: "sql",
    sql: "update invoices set currency = 'USD' where currency is null",
  });
  expect(tab !== undefined && takeQueuedRun(at, tab.id)).toBe(false);
});

test("the drawer collapses to its header", async () => {
  mount();
  await screen.findAllByTestId("data-query-log-row");

  fireEvent.click(screen.getByRole("button", { expanded: true }));

  await waitFor(() => expect(screen.queryAllByTestId("data-query-log-row")).toHaveLength(0));
});
