import "../../../test/dom.testing.ts";
import { Constellation, ConstellationId } from "@polaris/protocol";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { hostView } from "../../../routes/fixtures.testing.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import type { ConstellationRecord, ConstellationView } from "../../constellation/model/types.ts";
import { emptyConstellations } from "../../constellation/model/types.ts";
import { C1, C2 } from "../../sessions/preview/fixtures.ts";
import { USAGE } from "../../sessions/preview/settingsFixtures.ts";
import { type Bucket, NO_COST, noEstimate } from "../model/usage.ts";
import { UsageByConstellation } from "./UsageByConstellation.tsx";

afterEach(cleanup);

/** C1's graph under another id and name: a third and fourth row with the same spend. */
const copyOf = (view: ConstellationView, id: string, name: string): ConstellationView => ({
  ...view,
  constellation: new Constellation({ ...view.constellation, id: ConstellationId.make(id), name }),
});

const views = [C1, C2, copyOf(C1, "c3", "Resume tests"), copyOf(C1, "c4", "Mobile chrome")];

/** A view as the store keeps it, with an empty feed around the graph. */
const recordOf = (view: ConstellationView): ConstellationRecord => ({
  ...view,
  sequence: 0,
  proposals: [],
  handovers: [],
  digests: [],
  notifications: new Map(),
  progress: new Map(),
  messages: [],
});

const buckets: ReadonlyArray<Bucket> = USAGE.report.buckets;

const mount = async () => {
  const store = createStore<AppState>(() => ({
    ...initialState,
    hosts: [hostView("local")],
    constellations: {
      local: {
        ...emptyConstellations,
        byId: new Map(views.map((v) => [v.constellation.id, recordOf(v)])),
      },
    },
  }));

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
          navigation: createNavigation({ app: store, storage: null }),
          commands: createCommandRegistry({ platform: "mac" }),
        }}
      >
        <UsageByConstellation
          buckets={buckets}
          now={Date.now()}
          estimate={noEstimate}
          days={30}
          total={NO_COST}
        />
      </AppProvider>
    );
  });
};

const names = () =>
  screen
    .getAllByTestId("usage-constellation")
    .map((row) => row.querySelector("span span")?.textContent);

test("the first three, then Show all lists every constellation", async () => {
  await mount();

  expect(names()).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Show all 4" }));
  expect(names()).toHaveLength(4);
  expect(names()).toContain("Bench leases");
});

test("each bar splits the lead from its workers, on one scale for every row", async () => {
  await mount();

  const [first] = screen.getAllByTestId("constellation-cost-bar");

  // C1: the lead's 7.3M of 28.2M tokens (no prices, so the bar is by tokens).
  expect(first?.getAttribute("data-lead")).toBe((7.3 / 28.2).toFixed(2));
  expect(first?.style.width).toBe("240px");
  // Eleven worker sessions; the lead's own Attempt on the gate G1 isn't a worker.
  expect(screen.getAllByTestId("constellation-workers")[0]?.textContent).toBe("11");
});
