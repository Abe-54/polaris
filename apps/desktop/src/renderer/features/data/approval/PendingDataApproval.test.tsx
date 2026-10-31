import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { DataSource } from "@polaris/protocol";
import { Schema } from "effect";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { DataLayer } from "../data/hooks.tsx";
import { dataTabsStore } from "../model/store.ts";
import type { DataTab } from "../model/tabs.ts";
import { fixtureDataApi } from "../preview/fixtureApi.ts";
import { installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { FIXTURE_DATA_APPROVAL, FIXTURE_SESSIONS, FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { DATA_AT, DATA_WORKSPACE_ID, dataHost, dataHostModel } from "../preview/scene.ts";
import { ConnectionBar } from "../ui/ConnectionBar.tsx";

afterEach(() => {
  cleanup();
  standInBridge(null);
  dataTabsStore.setState({ sessions: {}, shown: null });
});

/** The connection bar on a source, with the backfill session waiting on analytics' approval. */
const mount = (sourceId: string, sources: ReadonlyArray<DataSource> = FIXTURE_SOURCES) => {
  const model = dataHostModel();
  const backfill = model.sessions.get(FIXTURE_SESSIONS.backfill.id);

  if (backfill === undefined) throw new Error("No backfill session in the scene");
  const sessions = new Map(model.sessions);

  sessions.set(backfill.session.id, { ...backfill, pendingApprovals: [FIXTURE_DATA_APPROVAL] });

  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [dataHost()],
    hostModels: { [DATA_AT.hostKey]: { ...model, sessions } },
  }));

  const active: DataTab = {
    kind: "sql",
    id: "q-1",
    sourceId,
    sql: "",
    params: [],
    title: "Query 1",
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
        <DataLayer api={fixtureDataApi({ sources })}>
          <ConnectionBar
            at={DATA_AT}
            hostKey={DATA_AT.hostKey}
            workspaceId={DATA_WORKSPACE_ID}
            active={active}
          />
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );
};

const openCard = async () => {
  const bar = await screen.findByTestId("data-connection-bar");

  act(() => {
    fireEvent.click(bar);
  });

  return screen.findByTestId("data-connection-card");
};

test("a source waiting on approval shows the agent's request in its connection card", async () => {
  mount("analytics");

  const card = await openCard();

  await waitFor(() => expect(card.textContent).toContain(FIXTURE_SESSIONS.backfill.title));
  expect(card.textContent).toContain("Approve");
});

test("another source's card shows no approval", async () => {
  mount("app");

  const card = await openCard();

  expect(card.textContent).not.toContain(FIXTURE_SESSIONS.backfill.title);
  expect(card.textContent).not.toContain("Approve");
});

/** The fixture's analytics source, changed as `change` says. */
const analytics = (change: Partial<typeof DataSource.Encoded>) =>
  FIXTURE_SOURCES.map((s) =>
    s.name === "analytics" ? new DataSource({ ...Schema.encodeSync(DataSource)(s), ...change }) : s
  );

test("a source renamed while its approval is pending still shows it, matched by target (F12)", async () => {
  mount("warehouse", analytics({ id: "src-warehouse", name: "warehouse" }));

  const card = await openCard();

  await waitFor(() => expect(card.textContent).toContain(FIXTURE_SESSIONS.backfill.title));
  expect(card.textContent).toContain("Approve");
});

test("a request for a source approved already shows settled and answers itself (F3)", async () => {
  const bridge = installFakeBridge();

  mount("analytics", analytics({ access: "approved" }));

  const card = await openCard();

  await waitFor(() => expect(card.textContent).toContain("Approved. Agents can read it now."));
  await waitFor(() =>
    expect(bridge.sent("dispatch").map(({ command }) => command._tag)).toEqual([
      "RespondToApproval",
    ])
  );
});
