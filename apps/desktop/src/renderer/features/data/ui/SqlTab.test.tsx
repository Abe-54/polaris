import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import { type CommandRegistry, createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { onDraftChange } from "../../session/state.ts";
import type { DataApi, QueryStreamInput } from "../data/api.ts";
import { DataLayer } from "../data/hooks.tsx";
import { closeDataTab, dataSessionKey, dataTabsStore, openSqlTab } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { setSqlSource } from "../sql/state.ts";
import { SqlTabBody } from "./SqlTab.tsx";

afterEach(cleanup);

const at = { hostKey: "local", sessionId: SessionId.make("s-overdue-totals") };

let next = 0;

const sqlTab = (sql: string, sourceId = "app"): Extract<DataTab, { kind: "sql" }> => ({
  kind: "sql",
  id: `sql-test-${++next}`,
  sourceId,
  sql,
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

/** A Host whose queries never finish: records each stream and whether it was cancelled. */
const hangingApi = () => {
  const streams: Array<{ input: QueryStreamInput; cancelled: boolean }> = [];

  const api: DataApi = {
    ...fixtureDataApi(),
    queryStream: (_at, input) => {
      const stream = { input, cancelled: false };

      streams.push(stream);

      return () => {
        stream.cancelled = true;
      };
    },
  };

  return { api, streams };
};

// CodeMirror reads "Mod" from navigator.platform, not from the app's key platform.
const mac = /Mac/.test(navigator.platform);

const pressRun = (repeat = false) => {
  const content = document.querySelector(".cm-content");

  if (content === null) throw new Error("no editor");
  fireEvent.keyDown(content, { key: "Enter", metaKey: mac, ctrlKey: !mac, repeat });
};

describe("a running query (F1, F2)", () => {
  test("⌘↵ held while it runs sends one query, not one per key repeat", async () => {
    const { api, streams } = hangingApi();

    mount(sqlTab("select * from invoices"), api);
    await run();
    pressRun();

    for (let i = 0; i < 8; i++) pressRun(true);

    expect(streams).toHaveLength(1);
    expect(screen.getByTestId("data-sql-cancel")).not.toBeNull();
  });

  test("Cancel stops it on the Host and says Cancelled", async () => {
    const { api, streams } = hangingApi();

    mount(sqlTab("select * from invoices"), api);
    await run();
    fireEvent.click(screen.getByTestId("data-sql-cancel"));

    expect(streams[0]?.cancelled).toBe(true);
    expect(screen.getByTestId("data-sql-results-quiet").textContent).toBe("Cancelled");
    expect(screen.getByTestId("data-sql-run").hasAttribute("disabled")).toBe(false);
  });

  test("Esc in the editor cancels it", async () => {
    const { api, streams } = hangingApi();

    mount(sqlTab("select * from invoices"), api);
    await run();
    const content = document.querySelector(".cm-content");

    if (content === null) throw new Error("no editor");
    fireEvent.keyDown(content, { key: "Escape" });

    expect(streams[0]?.cancelled).toBe(true);
    expect(screen.getByTestId("data-sql-results-quiet").textContent).toBe("Cancelled");
  });

  test("choosing another source cancels the query on the last one", async () => {
    const { api, streams } = hangingApi();
    const tab = sqlTab("select * from invoices");

    mount(tab, api);
    await run();
    act(() => setSqlSource(at, tab, "ledger"));

    expect(streams[0]?.cancelled).toBe(true);
  });

  test("closing its tab cancels it", async () => {
    const { api, streams } = hangingApi();

    openSqlTab("select * from invoices", "app", at);
    const tabs = dataTabsStore.getState().sessions[dataSessionKey(at)];
    const tab = tabs?.tabs.find((t) => t.id === tabs.active);

    if (tab?.kind !== "sql") throw new Error("no SQL tab");
    mount(tab, api);
    await run();
    act(() => closeDataTab(tab.id, at));

    expect(streams[0]?.cancelled).toBe(true);
  });
});

test("a tab opened with a notice says why it didn't run, with no source chosen (F6)", async () => {
  mount({ ...sqlTab("select 1", ""), notice: "This ran on ghost, which is gone or renamed." });

  expect((await screen.findByTestId("data-sql-notice")).textContent).toContain("ghost");
  expect(screen.getByTestId("data-sql-source").textContent).toContain("Choose a data source");
  expect(screen.getByTestId("data-sql-run").hasAttribute("disabled")).toBe(true);
});
