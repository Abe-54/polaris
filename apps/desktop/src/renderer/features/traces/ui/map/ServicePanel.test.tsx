import "../../../../test/dom.testing.ts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@polaris/ui";
import { serviceMap, servicePanel } from "../../model/map/index.ts";
import { traceTimes } from "../../model/waterfall/index.ts";
import { FIXTURE_DETAILS } from "../../preview/fixtures.ts";
import { SETTLE_TRACE_ID } from "../../preview/settle.ts";
import { ServicePanel } from "./ServicePanel.tsx";

afterEach(cleanup);

const panelOf = (name: string) => {
  const detail = FIXTURE_DETAILS.find((d) => d.summary.id === SETTLE_TRACE_ID);

  if (detail === undefined) throw new Error("no settle fixture");
  const model = servicePanel(serviceMap(traceTimes(detail)), name);

  if (model === null) throw new Error(`no ${name} panel`);
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

  return { model, panel: screen.getByTestId("service-panel") };
};

test("finding P6-9: a failed call among the slowest says so in words, not only in red", () => {
  const { model, panel } = panelOf("api.postmarkapp.com");
  const rows = within(panel).getAllByTestId("service-slowest");
  const failed = model.slowest.findIndex((s) => s.span.status === "error");

  expect(failed).toBeGreaterThanOrEqual(0);
  expect(rows.map((r, i) => [i === failed, r.textContent?.includes("error")])).toEqual(
    rows.map((_, i) => [i === failed, i === failed])
  );
});

test("finding P6-10: an inferred dependency's span count is named as the caller's client spans", () => {
  const { panel } = panelOf("postgresql");

  expect(within(panel).getByText("Client spans")).not.toBeNull();
  expect(within(panel).queryByText("Spans")).toBeNull();
});
