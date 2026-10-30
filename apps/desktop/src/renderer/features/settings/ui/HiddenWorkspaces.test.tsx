import "../../../test/dom.testing.ts";
import {
  Constellation,
  ConstellationId,
  ConstellationSettings,
  constellationSummaryOf,
  HostId,
  SessionId,
  WorkspaceId,
} from "@polaris/protocol";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostModel, hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, type Connection, initialState } from "../../../store/store.ts";
import { emptyConstellations } from "../../constellation/model/types.ts";
import type { HiddenWorkspaceRow } from "../model/hiddenWorkspaces.ts";
import { HiddenWorkspaces } from "./HiddenWorkspaces.tsx";

afterEach(cleanup);

const lead = constellationSummaryOf(
  new Constellation({
    id: ConstellationId.make("c1"),
    workspaceId: WorkspaceId.make("warehouse"),
    hostId: HostId.make("mac"),
    leadSessionId: SessionId.make("s1"),
    name: "Restock",
    state: "completed",
    revision: 0,
    settings: ConstellationSettings.make({}),
    tasks: [],
    attempts: [],
    pendingNotifications: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  })
);

const mount = (options: { readonly connected?: boolean } = {}) => {
  const removed: Array<HiddenWorkspaceRow> = [];
  const unhidden: Array<HiddenWorkspaceRow> = [];
  let answer = true;

  const state: AppState = {
    ...initialState,
    hosts: [hostView("mac", options.connected === false ? "offline" : "connected")],
    hostModels: {
      mac: hostModel([
        { id: "polaris", sessions: [{ id: "s0", state: "idle" }] },
        {
          id: "warehouse",
          hidden: true,
          sessions: [
            { id: "s1", state: "archived" },
            { id: "s2", state: "archived" },
          ],
        },
        { id: "attic", hidden: true, sessions: [{ id: "s3", state: "idle" }] },
      ]),
    },
    constellations: {
      mac: { ...emptyConstellations, listed: new Map([[lead.id, lead]]) },
    },
  };

  const store = createStore<AppState>(() => state);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <HiddenWorkspaces
        remove={async (row) => {
          removed.push(row);

          return answer;
        }}
        unhide={async (row) => {
          unhidden.push(row);

          return answer;
        }}
      />
    </AppProvider>
  );

  const row = (name: string) => {
    const found = screen
      .getAllByTestId("hidden-workspace")
      .find((el) => within(el).queryByText(name) !== null);

    if (found === undefined) throw new Error(`no row for ${name}`);

    return within(found);
  };

  return { removed, unhidden, row, refuse: () => (answer = false) };
};

test("lists only hidden workspaces, with what each holds", () => {
  mount();

  const names = screen
    .getAllByTestId("hidden-workspace")
    .map((el) => el.querySelector("span")?.textContent);

  expect(names).toEqual(["attic", "warehouse"]);
  expect(screen.queryByText("polaris")).toBeNull();
});

test("Remove asks first, names the real counts and that the folder stays, then removes", async () => {
  const { removed, row } = mount();
  const warehouse = row("warehouse");

  expect(warehouse.getByText("mac · 2 agent sessions · 1 constellation")).toBeTruthy();

  fireEvent.click(warehouse.getByRole("button", { name: "Remove workspace…" }));

  expect(removed).toEqual([]);
  expect(
    warehouse.getByText("Removes 2 agent sessions and 1 constellation. The folder stays on disk.")
  ).toBeTruthy();

  await act(async () => {
    fireEvent.click(warehouse.getByRole("button", { name: "Remove warehouse" }));
  });

  expect(removed.map((r) => [r.hostKey, r.workspaceId])).toEqual([["mac", "warehouse"]]);
  // Until the host drops the row, it can't be removed twice.
  expect(warehouse.getByText("Removing…")).toBeTruthy();
  expect(
    warehouse.getByRole("button", { name: "Remove workspace…" }).hasAttribute("disabled")
  ).toBe(true);
});

test("Cancel backs out without removing anything", () => {
  const { removed, row } = mount();
  const warehouse = row("warehouse");

  fireEvent.click(warehouse.getByRole("button", { name: "Remove workspace…" }));
  fireEvent.click(warehouse.getByRole("button", { name: "Cancel" }));

  expect(removed).toEqual([]);
  expect(warehouse.getByRole("button", { name: "Remove workspace…" })).toBeTruthy();
});

test("a refused removal returns to the row so the user can try again", async () => {
  const { refuse, row } = mount();
  const warehouse = row("warehouse");
  refuse();

  fireEvent.click(warehouse.getByRole("button", { name: "Remove workspace…" }));
  await act(async () => {
    fireEvent.click(warehouse.getByRole("button", { name: "Remove warehouse" }));
  });

  expect(warehouse.getByRole("button", { name: "Remove workspace…" })).toBeTruthy();
});

test.each([
  [{}, "attic", "Archive its last agent session to remove it"],
  [{ connected: false }, "warehouse", "mac isn't connected"],
] as const)("Remove is off and says why (%o, %s)", (options, name, why) => {
  const { row } = mount(options);
  const target = row(name);

  expect(target.getByText(why)).toBeTruthy();
  expect(target.getByRole("button", { name: "Remove workspace…" }).hasAttribute("disabled")).toBe(
    true
  );
});

test("Unhide shows the workspace again without removing it", async () => {
  const { removed, unhidden, row } = mount();

  await act(async () => {
    fireEvent.click(row("attic").getByRole("button", { name: "Unhide" }));
  });

  expect(unhidden.map((r) => r.workspaceId)).toEqual(["attic"]);
  expect(removed).toEqual([]);
});

test("Unhide is off while the host isn't connected", () => {
  const { row } = mount({ connected: false });

  expect(row("warehouse").getByRole("button", { name: "Unhide" }).hasAttribute("disabled")).toBe(
    true
  );
});
