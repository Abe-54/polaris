import "../../../../test/dom.testing.ts";
import "../../../../app/slots.tsx";
import { TerminalId } from "@polaris/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { createStore } from "zustand/vanilla";
import { createCommandRegistry } from "../../../../routes/commands.ts";
import { createNavigation } from "../../../../routes/navigation.ts";
import { AppProvider } from "../../../../shell/hooks.ts";
import type { AppState, Connection } from "../../../../store/store.ts";
import { type FakeBridge, installFakeBridge } from "../../../../test/bridge.testing.ts";
import { standInBridge } from "../../../bridge.ts";
import { fixtureAppState, HOST } from "../../../traces/preview/appState.ts";
import { FIXTURE_SESSION } from "../../../traces/preview/fixtures.ts";
import { isFailedSend } from "../../model/states.ts";
import { fixtureSend, LEDGER_CHECKOUT, type SendSpec } from "../../preview/sendLogFixtures.ts";
import { SendFailure } from "./SendFailure.tsx";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const App = ({ children }: { readonly children: ReactNode }) => {
  const store = createStore<AppState>(() => fixtureAppState());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  return (
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      {children}
    </AppProvider>
  );
};

const show = (spec: Partial<SendSpec>, variable: string | null, onSendAgain = () => undefined) => {
  const send = fixtureSend(
    {
      id: "e5b4a6f8",
      minutesAgo: 1,
      method: "GET",
      url: "http://localhost:4000/healthz",
      outcome: "refused",
      durationMs: 3,
      ...spec,
    },
    Date.now()
  );

  if (!isFailedSend(send)) throw new Error("the fixture has no response");

  render(
    <App>
      <SendFailure
        at={{ hostKey: HOST, sessionId: FIXTURE_SESSION }}
        hostKey={HOST}
        workspaceId="w-ledger"
        send={send}
        source={{ variable, environment: variable === null ? null : "dev" }}
        onSendAgain={onSendAgain}
      />
    </App>
  );
};

test("a refused connection names the address and the Host, and where the URL came from", () => {
  show({}, "base");

  const failure = screen.getByTestId("requests-send-failure");

  expect(failure.getAttribute("aria-label")).toBe("Connection refused");
  expect(failure.textContent).toContain(
    "Nothing is listening on localhost:4000 on Mac Studio. Start the dev server, or check {{base}} in env dev."
  );
  expect(screen.getByTestId("requests-send-failure-sent").textContent).toContain(
    "Mac Studio · ECONNREFUSED"
  );
});

test("Send again sends, and Open a terminal opens one in the Send's checkout", async () => {
  let again = 0;

  bridge.answerOk("terminal.open", { terminalId: TerminalId.make("term-1") });
  show({}, null, () => void again++);
  fireEvent.click(screen.getByRole("button", { name: "Send again" }));
  fireEvent.click(screen.getByRole("button", { name: "Open a terminal" }));

  expect(again).toBe(1);
  await waitFor(() =>
    expect(bridge.sent("terminal.open").map((open) => open.cwd)).toEqual([LEDGER_CHECKOUT])
  );
});

test("a timeout says how long it waited; a denied Send offers no terminal", () => {
  show({ outcome: "timeout", durationMs: 30_000 }, null);
  expect(screen.getByTestId("requests-send-failure").textContent).toContain(
    "localhost:4000 didn’t answer Mac Studio within 30 s."
  );
  cleanup();

  show({ outcome: "denied", url: "https://staging.ledger.dev/invoices/overdue" }, null);
  expect(screen.getByTestId("requests-send-failure").getAttribute("aria-label")).toBe(
    "Not sent: origin denied"
  );
  expect(screen.queryByRole("button", { name: "Open a terminal" })).toBeNull();
});
