import "../../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../../store/store.ts";
import { TracesLayer } from "../../data/hooks.tsx";
import { setMainView } from "../../model/mainView.ts";
import { tracesSelection } from "../../model/store.ts";
import { fixtureTracesApi } from "../../preview/fixtureApi.ts";
import { FIXTURE_SESSION } from "../../preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../preview/settle.ts";
import { TraceMain } from "../TraceMain.tsx";

afterEach(cleanup);

let hosts = 0;

const mount = () => {
  const at = { hostKey: `h-map-${++hosts}`, sessionId: FIXTURE_SESSION };
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));

  setMainView(at, "map");
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
        <TracesLayer api={fixtureTracesApi()}>
          <TraceMain
            at={at}
            hostKey={at.hostKey}
            workspaceId="ledger"
            traceId={SETTLE_TRACE_ID}
            spanId={null}
          />
        </TracesLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return at;
};

const node = (name: string) => {
  const found = screen.getAllByTestId("map-node").find((n) => n.dataset["node"] === name);

  if (found === undefined) throw new Error(`no node ${name}`);

  return found;
};

test("the map opens on the caller's service and draws every service and inferred dependency", async () => {
  mount();
  await screen.findByTestId("service-map");

  expect(screen.getAllByTestId("map-node").map((n) => n.dataset["node"])).toEqual([
    "settle-job",
    "ledger-api",
    "fx-rates",
    "audit-log",
    "notifier",
    "postgresql",
    "redis",
    "api.postmarkapp.com",
  ]);
  expect(screen.getByTestId("map-caller").textContent).toBe("bun run settle.ts · turn 11");
  expect(
    within(screen.getByTestId("service-panel")).getByRole("heading", { level: 2 }).textContent
  ).toBe("settle-job");
});

test("selecting a service fills the panel with its N+1, and a slow request opens the waterfall", async () => {
  const at = mount();

  await screen.findByTestId("service-map");
  fireEvent.click(node("notifier"));

  const panel = screen.getByTestId("service-panel");

  expect(node("notifier").getAttribute("aria-pressed")).toBe("true");
  expect(within(panel).getByTestId("service-n-plus-one").textContent).toBe(
    "12 calls to api.postmarkapp.com in one request: 65 ms each, 778 ms in all."
  );

  fireEvent.click(within(panel).getByTestId("service-slowest"));

  expect(screen.getByTestId("traces-main").dataset["view"]).toBe("waterfall");
  expect(tracesSelection(at).spanId).toBe("8a3d000000000041");
});

test("Errors only dims the services without errors and keeps the failing ones lit", async () => {
  mount();
  await screen.findByTestId("service-map");
  fireEvent.click(screen.getByTestId("waterfall-errors-only"));

  const lit = (name: string) => node(name).style.opacity === "1";

  expect(["notifier", "api.postmarkapp.com", "ledger-api"].map(lit)).toEqual([true, true, false]);
});
