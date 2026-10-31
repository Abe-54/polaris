import "../../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { TraceDetail } from "@polaris/protocol";
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
import { FIXTURE_DETAILS, FIXTURE_SESSION } from "../../preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../preview/settle.ts";
import { TraceMain } from "../TraceMain.tsx";
import { useTraceView } from "../waterfall/useTraceView.ts";
import { ServiceMap } from "./ServiceMap.tsx";

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
  expect(screen.getByTestId("map-caller").textContent).toBe("bun run settle.ts · during turn 11");
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

const settle = (): TraceDetail => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === SETTLE_TRACE_ID);

  if (detail === undefined) throw new Error("no settle fixture");

  return detail;
};

/** What TraceMain's Shown renders for the map: the trace view over one detail, then the map. */
const Map = ({ detail }: { readonly detail: TraceDetail }) => (
  <TooltipProvider>
    <ServiceMap trace={useTraceView(detail)} onOpenSpan={() => undefined} />
  </TooltipProvider>
);

const canvas = () => screen.getByRole("group", { name: /^Service map/ });

test("finding P6-6: after a pan, activating a service from the keyboard still selects it", () => {
  render(<Map detail={settle()} />);
  const layer = screen.getByTestId("service-map-layer");

  fireEvent.click(node("audit-log"));
  expect(node("audit-log").getAttribute("aria-pressed")).toBe("true");
  const before = layer.style.transform;

  fireEvent.pointerDown(canvas(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas(), { pointerId: 1, clientX: 160, clientY: 120 });
  fireEvent.pointerUp(canvas(), { pointerId: 1, clientX: 160, clientY: 120 });
  expect(layer.style.transform).not.toBe(before);
  // Enter or Space on a focused button, or a screen reader's activation, is a click alone.
  fireEvent.click(node("notifier"));
  expect(node("notifier").getAttribute("aria-pressed")).toBe("true");
});

test("a pan that ends on a service doesn't select it", () => {
  render(<Map detail={settle()} />);
  fireEvent.pointerDown(canvas(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas(), { pointerId: 1, clientX: 160, clientY: 120 });
  fireEvent.pointerUp(canvas(), { pointerId: 1, clientX: 160, clientY: 120 });
  fireEvent.click(node("notifier"), { detail: 1 });

  expect(node("notifier").getAttribute("aria-pressed")).toBe("false");
});

test("finding P6-7: a trace that grows while open keeps the user's pan and zoom", () => {
  const detail = settle();
  const { rerender } = render(<Map detail={detail} />);
  const layer = screen.getByTestId("service-map-layer");

  fireEvent.keyDown(canvas(), { key: "ArrowLeft" });
  fireEvent.keyDown(canvas(), { key: "=" });
  const panned = layer.style.transform;

  // The exporter's next batch: useTrace reads the trace again, a new detail with the same spans.
  rerender(<Map detail={{ ...detail, spans: [...detail.spans] }} />);

  expect(layer.style.transform).toBe(panned);
});

test("finding P6-8: a run no Turn is known to have launched isn't 'Started by the agent'", () => {
  const detail = settle();

  expect(detail.spans.every((s) => s.polaris.launchedTurn === null)).toBe(true);
  render(<Map detail={detail} />);

  expect(screen.getByTestId("service-map").textContent).not.toContain("Started by the agent");
  expect(screen.getByTestId("service-map").textContent).toContain("Started during a turn");
});

test("finding P6-11: connector labels are hidden from assistive technology with their lines", () => {
  render(<Map detail={settle()} />);

  const heard = screen
    .getAllByTestId("map-edge")
    .filter((e) => e.closest("[aria-hidden='true']") === null);

  expect(heard.map((e) => e.textContent)).toEqual([]);
});

test("finding P6-12: focus never scrolls the map's canvas; the foot stays put", () => {
  render(<Map detail={settle()} />);
  const box = canvas();

  box.scrollTop = 40;
  fireEvent.scroll(box);

  expect(box.scrollTop).toBe(0);
});
