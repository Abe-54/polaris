import "../../../test/dom.testing.ts";
// The app loads its slots first; shell/commands.ts reaches them through a cycle.
import "../../../app/slots.tsx";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { ArchivedGroup } from "./Archived.tsx";

const page = () => within(document.body);

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const model = hostModel([
  {
    id: "polaris",
    sessions: [
      { id: "kept", state: "idle" },
      { id: "spike", state: "archived" },
      { id: "notes", state: "archived" },
    ],
  },
]);

const mount = () => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [hostView("local")],
    hostModels: { local: model },
  }));

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  render(
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <ArchivedGroup hostKey="local" model={model} workspaceId="polaris" scope="w" now={0} />
    </AppProvider>
  );
};

const header = () => page().getByRole("button", { name: /Archived/ });

test("folded at first with its count; opening it lists the archived sessions only", () => {
  mount();

  expect(header().textContent).toBe("Archived2");
  expect(page().queryAllByTestId("archived-row")).toHaveLength(0);

  fireEvent.click(header());

  const titles = page()
    .getAllByTestId("archived-row")
    .map((r) => r.textContent?.slice(0, 5))
    .toSorted();

  expect(titles).toEqual(["notes", "spike"]);

  fireEvent.click(header());
  expect(page().queryAllByTestId("archived-row")).toHaveLength(0);
});

test("a row's Unarchive sends UnarchiveSession for that session", async () => {
  mount();
  fireEvent.click(header());

  const spike = page()
    .getAllByTestId("archived-row")
    .find((r) => r.textContent?.startsWith("spike"))!;

  fireEvent.click(within(spike).getByRole("button", { name: "Unarchive" }));
  await act(async () => {});

  const sent = bridge.sent("dispatch").map((d) => d.command);

  expect(sent.map((c) => c._tag)).toEqual(["UnarchiveSession"]);
  expect(sent[0] && "sessionId" in sent[0] ? `${sent[0].sessionId}` : null).toBe("spike");
});
