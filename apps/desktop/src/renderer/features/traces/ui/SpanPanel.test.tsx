import "../../../test/dom.testing.ts";
// The app's own load order: the shell's slots before the features that read them.
import "../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { TooltipProvider } from "@polaris/ui";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import { type AppState, initialState } from "../../../store/store.ts";
import { DataLayer } from "../../data/data/hooks.tsx";
import { dataSessionKey, dataTabsStore } from "../../data/model/store.ts";
import { fixtureDataApi } from "../../data/preview/fixtureApi.ts";
import type { TracesApi } from "../data/api.ts";
import { TracesLayer } from "../data/hooks.tsx";
import { publishOpenTrace } from "../model/openTrace.ts";
import { FIXTURE_DETAILS } from "../preview/fixtures.ts";
import { selectSpan, selectTrace, tracesSelection } from "../model/store.ts";
import { fixtureTracesApi } from "../preview/fixtureApi.ts";
import { BIG_TRACE, ERROR_TRACE, FIXTURE_SESSION } from "../preview/fixtures.ts";
import { SpanPanel } from "./SpanPanel.tsx";

afterEach(cleanup);

let hosts = 0;

const UPDATE = "a91f5d6e7b8c03c2";

const TEST_ROOT = "3c5d7e9f1a2b4c6d";

const mount = (
  traceId: string,
  spanId: string,
  api: TracesApi = fixtureTracesApi(),
  withHistory = true
) => {
  const at = { hostKey: `h-span-${++hosts}`, sessionId: FIXTURE_SESSION };
  const store = createStore<AppState>(() => ({ ...initialState, density: "calm" }));
  const navigation = createNavigation({ app: store, storage: null });

  const trace = FIXTURE_DETAILS.find((d) => d.summary.id === traceId);

  if (trace !== undefined)
    publishOpenTrace(at, withHistory ? trace : { summary: trace.summary, spans: trace.spans });

  selectTrace(at, traceId);
  selectSpan(at, spanId);

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
      <TooltipProvider>
        <DataLayer api={fixtureDataApi()}>
          <TracesLayer api={api}>
            <SpanPanel
              at={at}
              hostKey={at.hostKey}
              workspaceId="ledger"
              traceId={traceId}
              spanId={spanId}
            />
          </TracesLayer>
        </DataLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { at, navigation };
};

test("a database span opens the table its query wrote in its Data Source, in Data", async () => {
  const { at, navigation } = mount(BIG_TRACE.id, UPDATE);

  fireEvent.click(await screen.findByTestId("span-open-data"));

  const tabs = dataTabsStore.getState().sessions[dataSessionKey(at)];

  expect(tabs?.tabs.find((t) => t.id === tabs.active)).toMatchObject({
    kind: "table",
    sourceId: "app",
    ref: { schema: "public", name: "invoices" },
  });
  expect(navigation.current().mode).toBe("data");
  expect(screen.getByTestId("span-open-code").textContent).toContain("overdue.ts:61");
});

test("the span panel's pills show no ⌘4 or ⌘3, which only switch mode", async () => {
  mount(BIG_TRACE.id, UPDATE);

  expect((await screen.findByTestId("span-open-data")).textContent).toBe("Open in Data");
  expect(screen.getByTestId("span-open-code").textContent).toBe("overdue.ts:61");
});

test("a span that isn't a database call offers no Open in Data", async () => {
  mount(ERROR_TRACE.id, TEST_ROOT);

  await screen.findByTestId("span-open-code");
  expect(screen.queryByTestId("span-open-data")).toBeNull();
});

test("Events shows the exception's stack with the checkout's frames first", async () => {
  mount(ERROR_TRACE.id, TEST_ROOT);

  fireEvent.click(await screen.findByRole("tab", { name: /Events/ }));

  const frames = screen.getAllByTestId("span-frame");

  expect(frames.map((f) => f.dataset.inProject === "true")).toEqual([true, false]);
  expect(frames[0]?.textContent).toContain("test/overdue-totals.test.ts:42");
});

test("a redacted value reads faint whatever its key; the filter narrows the fields", async () => {
  const base = fixtureTracesApi();

  const api: TracesApi = {
    ...base,
    span: async (at, traceId, spanId) => {
      const read = await base.span(at, traceId, spanId);

      if (!read.ok) return read;
      const { span } = read.value;
      const attributes = { ...span.attributes, authorization: "[redacted]", note: "[redacted]" };

      return { ok: true, value: { ...read.value, span: { ...span, attributes } } };
    },
  };

  mount(BIG_TRACE.id, UPDATE, api);
  await screen.findByTestId("span-name");

  const faint = (key: string) =>
    within(
      screen.getAllByTestId("span-field").find((f) => f.textContent?.startsWith(key)) ??
        document.body
    ).getByText(/./, { selector: "[data-redacted]" }).textContent;

  expect(faint("authorization")).toBe("[redacted]");
  expect(faint("note")).toBe("[redacted]");
  expect(document.querySelectorAll("[data-redacted]")).toHaveLength(2);

  fireEvent.change(screen.getByTestId("span-filter"), { target: { value: "server" } });

  expect(screen.getAllByTestId("span-field").map((f) => f.textContent)).toEqual([
    "server.addresslocalhost",
    "server.port5432",
  ]);
});

test("closing the panel clears the span but keeps the trace open", async () => {
  const { at } = mount(BIG_TRACE.id, UPDATE);

  fireEvent.click(await screen.findByRole("button", { name: "Close span" }));

  expect(tracesSelection(at)).toEqual({ traceId: BIG_TRACE.id, spanId: null });
});

test("the panel explains a slow span against this checkout's history", async () => {
  mount(BIG_TRACE.id, UPDATE);
  expect((await screen.findByTestId("span-usual")).textContent).toBe(
    "Slow: usually 9 ms in this checkout"
  );
});

test("the panel omits usual duration on an old Daemon without history", async () => {
  mount(BIG_TRACE.id, UPDATE, fixtureTracesApi(), false);
  await screen.findByTestId("span-name");
  expect(screen.queryByTestId("span-usual")).toBeNull();
});
