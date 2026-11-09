/** Requests' send log tab and states (Paper Q2, Q3) on the fixture RequestsApi and app state. */
import "../../../test/dom.testing.ts";
import "../../../app/slots.tsx";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Predicate } from "effect";
import { createStore } from "zustand/vanilla";
import { Decisions } from "../../../commands.ts";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import type { AppState, Connection } from "../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { fixtureAppState, HOST, host } from "../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import type { RequestsApi } from "../data/api.ts";
import { RequestsLayer } from "../data/hooks.tsx";
import { clearSendLogView } from "../model/sendLogView.ts";
import { clearRequestsView } from "../model/store.ts";
import { fixtureOriginApproval, withPendingApprovals } from "../preview/approvalFixtures.ts";
import { fixtureRequestsApi, type FixtureOptions } from "../preview/fixtureApi.ts";
import { fixtureSends } from "../preview/sendLogFixtures.ts";
import { RequestsMode } from "./RequestsMode.tsx";
import { SendFixtureLayers } from "./send/fixture.tsx";

const AT = { hostKey: HOST, sessionId: FIXTURE_SESSION };

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  clearRequestsView(AT);
  clearSendLogView(AT);
  standInBridge(null);
});

const mount = (
  options: FixtureOptions = {},
  state: AppState = fixtureAppState(),
  change: Partial<RequestsApi> = {}
) => {
  const store = createStore<AppState>(() => state);

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const navigation = createNavigation({ app: store, storage: null });
  const commands = createCommandRegistry({ platform: "mac" });

  commands.provide(() => ({ keys: ["mode.requests"] }));
  navigation.actions.selectSession(AT);
  navigation.actions.setMode("requests");
  render(
    <AppProvider value={{ connection, navigation, commands }}>
      <TooltipProvider>
        <RequestsLayer api={{ ...fixtureRequestsApi(options), ...change }}>
          <SendFixtureLayers>
            <RequestsMode />
          </SendFixtureLayers>
        </RequestsLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { commands };
};

const sendRow = (text: string) => {
  const found = screen
    .getAllByTestId("requests-send-row")
    .find((r) => r.textContent?.includes(text));

  if (found === undefined) throw new Error(`No send row for ${text}`);

  return found;
};

const openSendLog = async () => {
  fireEvent.click(await screen.findByRole("radio", { name: /Send log/ }));

  return screen.findAllByTestId("requests-send-row");
};

test("the send log lists the checkout's Sends; a saved one opens its Request and its response", async () => {
  mount({ sends: fixtureSends(Date.now()) });
  await openSendLog();

  expect(screen.getAllByTestId("requests-send-group")[0]?.getAttribute("aria-label")).toBe(
    "LAST HOUR"
  );
  expect(within(sendRow("/healthz")).getByTestId("requests-send-status").textContent).toBe("—");
  expect(sendRow("/invoices/overdue?limit=50").textContent).toContain("Fix overdue totals");

  fireEvent.click(sendRow("/invoices/inv_2291"));

  await waitFor(() =>
    expect(screen.getByTestId("requests-name")).toHaveProperty("value", "Mark paid")
  );
  expect(screen.getByTestId("requests-send-pane").textContent).toContain("422");
  expect(sendRow("/invoices/inv_2291").getAttribute("aria-current")).toBe("true");
});

test("an agent's ad-hoc Send opens as a new, unsaved Request as it was sent", async () => {
  mount({ sends: fixtureSends(Date.now()) });
  await openSendLog();

  fireEvent.click(sendRow("/invoices/overdue?limit=50"));

  await waitFor(() =>
    expect(screen.getByTestId("requests-name")).toHaveProperty("value", "GET /invoices/overdue")
  );
  expect(screen.getByTestId("requests-url")).toHaveProperty(
    "value",
    "http://localhost:4000/invoices/overdue?limit=50&customer=cus_8f2a&include=lines"
  );
});

test("the send log's filter is its own and keeps across the tab switch", async () => {
  mount({ sends: fixtureSends(Date.now()) });
  await openSendLog();

  fireEvent.change(screen.getByTestId("requests-send-log-filter"), { target: { value: "500" } });
  expect(screen.getAllByTestId("requests-send-row")).toHaveLength(1);

  fireEvent.click(screen.getByRole("radio", { name: /Requests/ }));
  expect(screen.getByTestId("requests-filter")).toHaveProperty("value", "");
  await openSendLog();
  expect(screen.getByTestId("requests-send-log-filter")).toHaveProperty("value", "500");
  expect(screen.getAllByTestId("requests-send-row")).toHaveLength(1);
});

test("a checkout without .http files hands the work to an agent first, then ⌘N and a curl", async () => {
  const { commands } = mount({ files: [] });

  const empty = await screen.findByTestId("requests-empty-checkout");

  expect(
    [...empty.querySelectorAll("button")].map((b) => b.textContent?.replace(/\s+/g, " "))
  ).toEqual([
    "Ask an agent to write requests for this app’s routes↵",
    "New request in http/requests.http⌘N",
    "Paste a curl command⌘V",
  ]);

  fireEvent.click(screen.getByTestId("requests-ask-agent"));
  await waitFor(() =>
    expect(
      bridge
        .sent("dispatch")
        .flatMap(({ command }) =>
          Predicate.isTagged(command, "SendTurn") ? [command.prompt] : []
        )[0]
    ).toContain("Write .http files for this app's routes")
  );

  await act(async () => void commands.run("requests.new"));
  await waitFor(() =>
    expect(screen.getByTestId("requests-name")).toHaveProperty("value", "New request")
  );
});

test("an agent's Send to a remote origin waits on the same card in Requests; Approve lets it through", async () => {
  const request = fixtureOriginApproval(FIXTURE_SESSION, "r-staging-post");

  mount({}, withPendingApprovals(fixtureAppState(), HOST, FIXTURE_SESSION, [request]));

  const card = await screen.findByTestId("origin-approval");

  expect(within(card).getByRole("heading").textContent).toBe(
    "Let agents send to staging.ledger.dev?"
  );
  fireEvent.click(within(card).getByTestId("origin-approval-approve"));

  await waitFor(() =>
    expect(
      bridge
        .sent("dispatch")
        .flatMap(({ command }) =>
          Predicate.isTagged(command, "RespondToApproval")
            ? [{ requestId: command.requestId, decision: command.decision }]
            : []
        )
    ).toEqual([
      {
        requestId: request.id,
        decision: Decisions.Allow({ remember: true, originScope: "reads-and-writes" }),
      },
    ])
  );
});

test("while the Host is offline and nothing was read, Requests says so as Traces does", () => {
  const offline = { ...host, status: { ...host.status, state: "offline" as const } };

  // An offline Host's watch answers nothing.
  mount({}, fixtureAppState(offline), { watch: () => () => undefined });

  expect(screen.getByTestId("requests-host-offline").textContent).toContain(
    "Mac Studio is offline"
  );
});
