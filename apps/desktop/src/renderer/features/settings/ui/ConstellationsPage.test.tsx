import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import type { HostResourcesSnapshot, WorkerCap } from "../model/resources.ts";
import { type ResourcesClient, setResourcesClient } from "../resources.ts";
import { ConstellationsPage } from "./ConstellationsPage.tsx";

afterEach(cleanup);

const snapshot = (workerCap: WorkerCap): HostResourcesSnapshot => ({
  resources: [],
  resourceLeases: [],
  waiting: [],
  overdueLeaseIds: [],
  workerCap,
});

/** A fake daemon per host; records every cap change, which this page must never make. */
const fake = (caps: Readonly<Record<string, WorkerCap>>) => {
  const setCaps: Array<[string, number | null]> = [];

  const answer = (hostKey: string) => {
    const cap = caps[hostKey];

    return Promise.resolve(
      cap === undefined
        ? ({ ok: false, error: { code: "Unsupported", message: "no" } } as const)
        : ({ ok: true, value: snapshot(cap) } as const)
    );
  };

  const client: ResourcesClient = {
    get: answer,
    declare: answer,
    remove: answer,
    release: answer,
    setCap: (hostKey, cap) => {
      setCaps.push([hostKey, cap]);

      return answer(hostKey);
    },
  };

  setResourcesClient(client);

  return setCaps;
};

const mount = async () => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [hostView("studio"), hostView("vm"), hostView("pi", "offline")],
  }));

  const navigation = createNavigation({ app: store, storage: null });

  await act(async () => {
    render(
      <AppProvider
        value={{
          connection: {
            store,
            openSession: () => () => undefined,
            setDensity: () => undefined,
            setAppearance: () => undefined,
          },
          navigation,
          commands: createCommandRegistry({ platform: "mac" }),
        }}
      >
        <ConstellationsPage />
      </AppProvider>
    );
  });

  return navigation;
};

test("Workers at once shows each host's slots read-only, and Hosts… is where they change", async () => {
  const setCaps = fake({
    studio: { cap: 12, default: 4, working: 2, waiting: 0 },
    vm: { cap: 4, default: 2, working: 3, waiting: 1 },
  });

  const navigation = await mount();
  const card = within(screen.getByTestId("workers-at-once"));

  expect(card.getAllByTestId("worker-count").map((el) => el.textContent)).toEqual([
    "2 / 12",
    "3 / 4",
  ]);
  expect(card.getByText("5 working · 11 free · 1 waiting")).not.toBeNull();
  expect(card.getByText("Not connected")).not.toBeNull();

  // Display only: the one control is the link to Hosts.
  expect(card.getAllByRole("button").map((b) => b.textContent)).toEqual(["Hosts…"]);
  expect(card.queryByRole("spinbutton")).toBeNull();
  expect(card.queryByRole("textbox")).toBeNull();

  fireEvent.click(card.getByRole("button", { name: "Hosts…" }));
  expect(navigation.store.getState().settings?.section).toBe("hosts");
  expect(setCaps).toEqual([]);
});

test("a daemon that doesn't run workers says so instead of drawing empty slots", async () => {
  fake({ studio: { cap: 2, default: 2, working: 0, waiting: 0 } });
  await mount();
  const card = within(screen.getByTestId("workers-at-once"));

  expect(card.getByText("This daemon doesn't run workers")).not.toBeNull();
  expect(card.getAllByTestId("worker-slots")).toHaveLength(1);
});

test("spend per constellation is on Usage, one click away", async () => {
  fake({});
  const navigation = await mount();

  fireEvent.click(screen.getByRole("button", { name: "Spend in Usage…" }));
  expect(navigation.store.getState().settings?.section).toBe("usage");
});
