/** @jsxImportSource ../../../../apps/desktop/node_modules/react */
/**
 * P6 repros on the real Service map view (ServiceMap over useTraceView, and the service panel).
 * Each test names a finding in the P6 report, fails on 99ca0343d and should pass once it's fixed.
 */
import "../../../../apps/desktop/src/renderer/test/dom.testing.ts";
import { afterEach, expect, test } from "bun:test";
import type { TraceDetail } from "../../../../packages/protocol/src/index.ts";
import { TooltipProvider } from "../../../../packages/ui/src/index.ts";
import { cleanup, fireEvent, render, screen, within } from "./deps.ts";
import { serviceMap, servicePanel } from "../../../../apps/desktop/src/renderer/features/traces/model/map/index.ts";
import { traceTimes } from "../../../../apps/desktop/src/renderer/features/traces/model/waterfall/index.ts";
import { FIXTURE_DETAILS } from "../../../../apps/desktop/src/renderer/features/traces/preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../../../apps/desktop/src/renderer/features/traces/preview/settle.ts";
import { ServiceMap } from "../../../../apps/desktop/src/renderer/features/traces/ui/map/ServiceMap.tsx";
import { ServicePanel } from "../../../../apps/desktop/src/renderer/features/traces/ui/map/ServicePanel.tsx";
import { useTraceView } from "../../../../apps/desktop/src/renderer/features/traces/ui/waterfall/useTraceView.ts";

afterEach(cleanup);

const settle = (): TraceDetail => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === SETTLE_TRACE_ID);

  if (detail === undefined) throw new Error("no settle fixture");

  return detail;
};

/** What TraceMain's Shown renders for the map: the trace view over one detail, then the map. */
const Map = ({ detail }: { readonly detail: TraceDetail }) => {
  const trace = useTraceView(detail);

  return <ServiceMap trace={trace} onOpenSpan={() => undefined} />;
};

const mount = (detail: TraceDetail) =>
  render(
    <TooltipProvider>
      <Map detail={detail} />
    </TooltipProvider>
  );

const canvas = () => screen.getByRole("group", { name: /^Service map/ });

const node = (name: string) => {
  const found = screen.getAllByTestId("map-node").find((n) => n.dataset["node"] === name);

  if (found === undefined) throw new Error(`no node ${name}`);

  return found;
};

test("finding P6-6: after a pan, activating a service from the keyboard still selects it", () => {
  mount(settle());
  const box = canvas();
  const layer = screen.getByTestId("service-map-layer");

  // Enter or Space on a focused button, or a screen reader's activation, is a click alone.
  fireEvent.click(node("audit-log"));
  expect(node("audit-log").getAttribute("aria-pressed")).toBe("true");

  const before = layer.style.transform;

  fireEvent.pointerDown(box, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(box, { pointerId: 1, clientX: 160, clientY: 120 });
  fireEvent.pointerUp(box, { pointerId: 1, clientX: 160, clientY: 120 });
  expect(layer.style.transform).not.toBe(before);
  fireEvent.click(node("notifier"));

  expect(node("notifier").getAttribute("aria-pressed")).toBe("true");
});

test("finding P6-7: a trace that grows while open keeps the user's pan and zoom", () => {
  const detail = settle();
  const { rerender } = mount(detail);
  const layer = screen.getByTestId("service-map-layer");

  fireEvent.keyDown(canvas(), { key: "ArrowLeft" });
  fireEvent.keyDown(canvas(), { key: "=" });
  const panned = layer.style.transform;

  // The exporter's next batch: useTrace reads the trace again, a new detail with the same spans.
  rerender(
    <TooltipProvider>
      <Map detail={{ ...detail, spans: [...detail.spans] }} />
    </TooltipProvider>
  );

  expect(layer.style.transform).toBe(panned);
});

test("finding P6-8: a run no Turn is known to have launched isn't 'Started by the agent'", () => {
  const detail = settle();

  expect(detail.spans.every((s) => s.polaris.launchedTurn === null)).toBe(true);
  mount(detail);

  expect(screen.getByTestId("service-map").textContent).not.toContain("Started by the agent");
});

test("finding P6-9: a failed call among the slowest says so in words, not only in red", () => {
  const model = servicePanel(serviceMap(traceTimes(settle())), "api.postmarkapp.com");

  if (model === null) throw new Error("no postmark panel");
  render(
    <TooltipProvider>
      <ServicePanel
        model={model}
        onSelect={() => undefined}
        onClose={() => undefined}
        onOpen={() => undefined}
      />
    </TooltipProvider>
  );
  const rows = within(screen.getByTestId("service-panel")).getAllByTestId("service-slowest");
  const failed = model.slowest.findIndex((s) => s.span.status === "error");

  expect(failed).toBeGreaterThanOrEqual(0);
  expect(rows[failed]?.textContent?.toLowerCase()).toContain("error");
});
