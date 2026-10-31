import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { SessionId } from "@polaris/protocol";
import { createStore } from "zustand/vanilla";
import { type CommandRegistry, createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { shellContext } from "../../../shell/commands.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { DataLayer } from "../data/hooks.tsx";
import { type DataSessionKey, dataSessionKey, dataTabsStore } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { useNewSqlTab } from "./useNewSqlTab.ts";

afterEach(cleanup);

let n = 0;

const Probe = ({ at, active }: { at: DataSessionKey; active: DataTab | null }) => {
  useNewSqlTab(at, active);

  return null;
};

const mount = (active: DataTab | null, mode: "data" | "edit" = "data") => {
  const at = { hostKey: "local", sessionId: SessionId.make(`s-new-sql-${++n}`) };
  const store = createStore<AppState>(() => initialState);
  const commands: CommandRegistry = createCommandRegistry({ platform: "mac" });

  const connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  commands.provide(shellContext({ connection, navigation }));
  navigation.actions.setMode(mode);
  render(
    <AppProvider value={{ connection, navigation, commands }}>
      <DataLayer api={fixtureDataApi()}>
        <Probe at={at} active={active} />
      </DataLayer>
    </AppProvider>
  );

  const opened = () => {
    const tabs = dataTabsStore.getState().sessions[dataSessionKey(at)];

    return tabs?.tabs.find((t) => t.id === tabs.active);
  };

  return { commands, opened };
};

test("⌘T opens an empty SQL tab on the open table's Data Source", () => {
  const { commands, opened } = mount({
    kind: "table",
    id: "t",
    sourceId: "ledger",
    table: "invoices",
    ref: { schema: "public", name: "invoices" },
  });

  expect(commands.run("data.newSqlTab")).toBe(true);
  expect(opened()).toMatchObject({ kind: "sql", sql: "", sourceId: "ledger", title: "Query 1" });
});

test("with no tab open, it uses the first Data Source once they arrive", async () => {
  const { commands, opened } = mount(null);

  await waitFor(() => expect(commands.run("data.newSqlTab")).toBe(true));
  expect(opened()).toMatchObject({ kind: "sql", sourceId: "app" });
});

test("outside Data, ⌘T is left to the editor", () => {
  const { commands, opened } = mount(
    {
      kind: "table",
      id: "t",
      sourceId: "ledger",
      table: "invoices",
      ref: { schema: "public", name: "invoices" },
    },
    "edit"
  );

  expect(commands.run("data.newSqlTab")).toBe(false);
  expect(opened()).toBeUndefined();
});
