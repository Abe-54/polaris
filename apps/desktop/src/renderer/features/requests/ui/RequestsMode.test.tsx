/** ⌘6 Requests end to end on the fixture RequestsApi, recording what the view asks of it. */
import "../../../test/dom.testing.ts";
import "../../../app/slots.tsx";
import { type HttpRequest, RequestTarget } from "@polaris/protocol";
import { TooltipProvider } from "@polaris/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../routes/commands.ts";
import { createNavigation } from "../../../routes/navigation.ts";
import { AppProvider } from "../../../shell/hooks.ts";
import type { AppState, Connection } from "../../../store/store.ts";
import { fixtureAppState, HOST, host } from "../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import type { RequestsApi, SendInput } from "../data/api.ts";
import { RequestsLayer } from "../data/hooks.tsx";
import { clearRequestsView } from "../model/store.ts";
import { fixtureRequestsApi } from "../preview/fixtureApi.ts";
import { RequestsMode } from "./RequestsMode.tsx";
import { SendFixtureLayers } from "./send/fixture.tsx";

const AT = { hostKey: HOST, sessionId: FIXTURE_SESSION };

interface Recorded {
  readonly saves: Array<{ request: HttpRequest; previousName: string | null }>;
  readonly sends: Array<SendInput>;
  readonly curls: Array<string>;
}

interface Fixture {
  readonly api: RequestsApi;
  readonly calls: Recorded;
}

/** The fixture api, its calls recorded; each test gets a fresh session so stores don't leak. */
const recorded = (): Fixture => {
  const base = fixtureRequestsApi();
  const calls: Recorded = { saves: [], sends: [], curls: [] };

  return {
    calls,
    api: {
      ...base,
      save: (at, request, previousName) => {
        calls.saves.push({ request, previousName });

        return base.save(at, request, previousName);
      },
      send: (at, input) => {
        calls.sends.push(input);

        return base.send(at, input);
      },
      parseCurl: (at, text) => {
        calls.curls.push(text);

        return base.parseCurl(at, text);
      },
    },
  };
};

const mount = (api: RequestsApi, state: AppState = fixtureAppState()) => {
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
        <RequestsLayer api={api}>
          <SendFixtureLayers>
            <RequestsMode />
          </SendFixtureLayers>
        </RequestsLayer>
      </TooltipProvider>
    </AppProvider>
  );

  return { commands };
};

afterEach(() => {
  cleanup();
  clearRequestsView(AT);
});

const row = (name: string) => {
  const found = screen.getAllByTestId("requests-row").find((r) => r.textContent?.includes(name));

  if (found === undefined) throw new Error(`No row for ${name}`);

  return found;
};

test("the sidebar groups the checkout's Requests by file and opens the first", async () => {
  const { api } = recorded();

  mount(api);
  await screen.findAllByTestId("requests-row");

  expect(screen.getAllByTestId("requests-file").map((f) => f.getAttribute("aria-label"))).toEqual([
    "http/customers.http",
    "http/invoices.http",
    "http/webhooks.http",
  ]);
  expect(within(screen.getByTestId("requests-sidebar")).getByText("14")).toBeTruthy();
  expect(screen.getByTestId("requests-name")).toHaveProperty("value", "Get customer");
});

test("an edit marks the Request unsaved, and ⌘S writes it through requests.save", async () => {
  const { api, calls } = recorded();
  const { commands } = mount(api);

  fireEvent.click(await waitFor(() => row("List overdue")));
  expect(screen.queryByTestId("requests-unsaved")).toBeNull();
  fireEvent.change(screen.getByTestId("requests-url"), {
    target: { value: "{{base}}/invoices/overdue?limit=10" },
  });
  await waitFor(() =>
    expect(within(row("List overdue")).getByTestId("requests-unsaved")).toBeTruthy()
  );
  expect(commands.enabled("requests.save")).toBe(true);

  await act(async () => void commands.run("requests.save"));

  expect(calls.saves).toHaveLength(1);
  expect(calls.saves[0]?.request.url).toBe("{{base}}/invoices/overdue?limit=10");
  expect(calls.saves[0]?.request.file).toBe("http/invoices.http");
  await waitFor(() => expect(screen.queryByTestId("requests-unsaved")).toBeNull());
});

test("renaming saves under the new name with the old one, so the file entry moves", async () => {
  const { api, calls } = recorded();
  const { commands } = mount(api);

  fireEvent.click(await waitFor(() => row("Mark paid")));
  fireEvent.change(screen.getByTestId("requests-name"), { target: { value: "Settle invoice" } });
  await act(async () => void commands.run("requests.save"));

  expect(calls.saves[0]?.previousName).toBe("Mark paid");
  await waitFor(() => expect(row("Settle invoice")).toBeTruthy());
  expect(screen.getByTestId("requests-name")).toHaveProperty("value", "Settle invoice");
});

test("send sends the saved Request by ref, and an edited one as written", async () => {
  const { api, calls } = recorded();

  mount(api);
  fireEvent.click(await waitFor(() => row("Void invoice")));
  await act(async () => void fireEvent.click(screen.getByTestId("requests-send")));

  expect(calls.sends[0]).toEqual({
    target: RequestTarget.cases.Saved.make({
      ref: { file: "http/invoices.http", name: "Void invoice" },
    }),
    environment: "dev",
  });
  await waitFor(() =>
    expect(screen.getByTestId("requests-send-pane").textContent).toContain("200 OK")
  );

  fireEvent.change(screen.getByTestId("requests-url"), { target: { value: "{{base}}/x" } });
  await act(async () => void fireEvent.click(screen.getByTestId("requests-send")));

  const edited = calls.sends[1]?.target;

  expect(edited !== undefined && RequestTarget.guards.Inline(edited)).toBe(true);
  expect(edited).toMatchObject({
    name: "Void invoice",
    request: { method: "DELETE", url: "{{base}}/x" },
  });
});

test("a curl command pasted outside a field opens as a new, unsaved Request", async () => {
  const { api, calls } = recorded();

  mount(api);
  await screen.findAllByTestId("requests-row");
  const text = "curl -X POST https://localhost:4000/v1/payments -d '{}'";

  fireEvent.paste(screen.getByTestId("requests-mode"), {
    clipboardData: { getData: () => text },
  });

  await waitFor(() =>
    expect(screen.getByTestId("requests-name")).toHaveProperty("value", "POST /v1/payments")
  );
  expect(calls.curls).toEqual([text]);
  expect(screen.getByText("http/requests.http · not saved")).toBeTruthy();
});

test("a Daemon without Requests says so instead of the view", () => {
  const { api } = recorded();
  const shown = host;

  const state = fixtureAppState({
    ...shown,
    status: {
      ...shown.status,
      capabilities: shown.status.capabilities.filter((c) => c !== "requests"),
    },
  });

  mount(api, state);

  expect(screen.getByTestId("requests-unsupported").textContent).toContain(
    "Requests need a newer daemon on Mac Studio"
  );
});
