/** The send pane on fixture Traces, Data and Requests apis: its trace live, its tables, and where they open. */
import "../../../../test/dom.testing.ts";
import "../../../../app/slots.tsx";
import {
  RequestTarget,
  Send,
  type TraceDetail,
  TraceId,
  type TracesSnapshot,
} from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import type { AppState, Connection } from "../../../../store/store.ts";
import { DataLayer } from "../../../data/data/hooks.tsx";
import { dataSessionKey, dataTabsStore } from "../../../data/model/store.ts";
import { fixtureDataApi } from "../../../data/preview/fixtureApi.ts";
import { tracesSelection } from "../../../traces/index.ts";
import type { TracesApi } from "../../../traces/data/api.ts";
import { TracesLayer } from "../../../traces/data/hooks.tsx";
import { buildTrace } from "../../../traces/preview/build.ts";
import { fixtureAppState, HOST } from "../../../traces/preview/appState.ts";
import { FIXTURE_CHECKOUT, FIXTURE_SESSION } from "../../../traces/preview/fixtures.ts";
import type { RequestsApi, SendInput } from "../../data/api.ts";
import { RequestsLayer } from "../../data/hooks.tsx";
import { clearRequestsView, requestsView } from "../../model/store.ts";
import { fixtureRequestsApi } from "../../preview/fixtureApi.ts";
import { AGENT_SEND, AGENT_SEND_FIELDS, SEND_TRACE, sendTracesApi } from "./fixture.tsx";
import { SendPane } from "./SendPane.tsx";

const AT = { hostKey: HOST, sessionId: FIXTURE_SESSION };

const USER_SEND = new Send({
  ...AGENT_SEND_FIELDS,
  id: "send-user-1",
  requestRef: { file: "http/invoices.http", name: "Recalculate overdue" },
  url: "http://localhost:4000/invoices/overdue/recalculate",
  status: 200,
  statusText: "OK",
  responseBody: '{"recalculated":214}',
  durationMs: 840,
  traceId: TraceId.make(SEND_TRACE.id),
  by: { kind: "user", sessionId: FIXTURE_SESSION },
  outcome: "ok",
});

const recordingRequests = () => {
  const sends: Array<SendInput> = [];
  const base = fixtureRequestsApi();

  const api: RequestsApi = {
    ...base,
    send: (at, input) => {
      sends.push(input);

      return base.send(at, input);
    },
  };

  return { api, sends };
};

const mount = (
  send: Send,
  traces: TracesApi = sendTracesApi(),
  requests: RequestsApi = fixtureRequestsApi()
) => {
  const store = createStore<AppState>(() => fixtureAppState());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });

  navigation.actions.selectSession(AT);
  navigation.actions.setMode("requests");
  render(
    <AppProvider
      value={{ connection, navigation, commands: createCommandRegistry({ platform: "mac" }) }}
    >
      <TooltipProvider>
        <RequestsLayer api={requests}>
          <TracesLayer api={traces}>
            <DataLayer api={fixtureDataApi()}>
              <SendPane at={AT} hostKey={HOST} workspaceId="ledger" latest={send} sending={false} />
            </DataLayer>
          </TracesLayer>
        </RequestsLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { navigation };
};

afterEach(() => {
  cleanup();
  clearRequestsView(AT);
  dataTabsStore.setState({ sessions: {}, shown: null });
});

const rowNames = () =>
  screen.queryAllByTestId("send-trace-row").map((row) => row.getAttribute("title"));

const tables = () =>
  screen.queryAllByTestId("send-data-table").map((row) => row.textContent?.replace(/\s+/g, " "));

test("a send to an instrumented app shows its spans from send · polaris down, and the tables it touched", async () => {
  mount(USER_SEND);

  expect(screen.getByTestId("send-status").textContent).toContain("200 OK");
  expect(screen.getByTestId("send-body").textContent).toBe('{\n  "recalculated": 214\n}');
  await waitFor(() => expect(rowNames()).toHaveLength(6));
  expect(rowNames()[0]).toBe("send · polaris");
  expect(rowNames()[1]).toBe("POST /invoices/overdue/recalculate · ledger-api");
  expect(tables()).toEqual(["customersread", "invoiceswrote", "audit_logwrote"]);
});

test("an error span's table reads write failed, and the error span is drawn critical", async () => {
  mount(AGENT_SEND);

  await waitFor(() => expect(tables()).toEqual(["invoices×2write failed"]));

  const failed = screen
    .getAllByTestId("send-trace-row")
    .filter((row) => row.hasAttribute("data-error"))
    .map((row) => row.getAttribute("title"));

  expect(failed).toEqual([
    "send · polaris",
    "POST /invoices/:id/void · ledger-api",
    "UPDATE ledger_overdue · ledger-api",
  ]);
});

test("the trace updates as spans arrive: a grown summary reads the trace again", async () => {
  const full = buildTrace(SEND_TRACE, FIXTURE_CHECKOUT);

  const early: TraceDetail = {
    summary: { ...full.summary, spans: 1 },
    spans: full.spans.filter((s) => s.parentId === null),
  };

  let shown = early;
  let push: ((traces: TracesSnapshot["traces"]) => void) | null = null;
  const base = sendTracesApi([early]);

  const live: TracesApi = {
    ...base,
    watch: (at, filter, on) =>
      base.watch(at, filter, {
        ...on,
        next: (snapshot) => {
          push = (traces) => on.next({ ...snapshot, traces });
          on.next({ ...snapshot, traces: [shown.summary] });
        },
      }),
    get: () => Promise.resolve({ ok: true, value: shown }),
  };

  mount(USER_SEND, live);
  await waitFor(() => expect(rowNames()).toEqual(["send · polaris"]));
  expect(screen.getByTestId("send-data-note").textContent).toBe(
    "Nothing to show without database spans."
  );

  shown = full;
  await waitFor(() => expect(push).not.toBeNull());
  act(() => push?.([full.summary]));

  await waitFor(() => expect(rowNames()).toHaveLength(6));
  expect(tables()).toHaveLength(3);
});

test("Open in Traces opens the send's trace, and a row opens it at that span", async () => {
  const { navigation } = mount(USER_SEND);

  fireEvent.click(screen.getByTestId("send-open-traces"));
  expect(navigation.store.getState().mode).toBe("traces");
  expect(tracesSelection(AT)).toEqual({ traceId: SEND_TRACE.id, spanId: null });

  await waitFor(() => expect(rowNames()).toHaveLength(6));

  const update = screen
    .getAllByTestId("send-trace-row")
    .find((row) => row.getAttribute("title")?.startsWith("UPDATE"));

  fireEvent.click(update ?? document.body);
  expect(tracesSelection(AT)).toEqual({ traceId: SEND_TRACE.id, spanId: "e1b2c3d4e5f60718" });
});

const dataTabs = () => dataTabsStore.getState().sessions[dataSessionKey(AT)]?.tabs ?? [];

test("Open in Data opens the picked table in the span's Data Source; Open statement its SQL", async () => {
  const { navigation } = mount(USER_SEND);

  await waitFor(() => expect(tables()).toHaveLength(3));
  fireEvent.click(screen.getAllByTestId("send-data-table")[1] ?? document.body);
  fireEvent.click(await screen.findByTestId("send-open-data"));
  expect(navigation.store.getState().mode).toBe("data");
  expect(dataTabs()).toMatchObject([{ kind: "table", sourceId: "app", table: "invoices" }]);

  fireEvent.click(screen.getByTestId("send-open-statement"));
  expect(dataTabs()[1]).toMatchObject({
    sourceId: "app",
    sql: "UPDATE invoices SET overdue_total = $1 WHERE id = ANY($2)",
  });
});

test("an agent's ad-hoc send reads not saved; Save as request opens it as a draft without Polaris's traceparent", async () => {
  mount(AGENT_SEND);

  expect(screen.getByTestId("send-not-saved").textContent).toBe("not saved");
  fireEvent.click(screen.getByTestId("send-save-as-request"));
  const view = requestsView(AT);
  const draft = view.open === null ? undefined : view.drafts[view.open];

  expect(draft).toMatchObject({
    file: "http/requests.http",
    name: "POST /invoices/42/void",
    url: "http://localhost:4000/invoices/42/void",
    headers: [{ name: "content-type", value: "application/json" }],
    body: '{ "reason": "duplicate" }',
  });
});

test("Send again sends the recorded request inline, and is off when a secret was masked", async () => {
  const { api, sends } = recordingRequests();

  mount(AGENT_SEND, sendTracesApi(), api);
  fireEvent.click(screen.getByTestId("send-again"));
  await waitFor(() => expect(sends).toHaveLength(1));
  expect(sends[0]).toEqual({
    target: RequestTarget.cases.Inline.make({
      request: {
        method: "POST",
        url: "http://localhost:4000/invoices/42/void",
        headers: [{ name: "content-type", value: "application/json" }],
        body: '{ "reason": "duplicate" }',
      },
    }),
    environment: "dev",
  });
  cleanup();

  mount(new Send({ ...AGENT_SEND_FIELDS, url: "http://localhost:4000/void?token=[redacted]" }));
  expect(within(document.body).getByTestId("send-again").hasAttribute("disabled")).toBe(true);
});
