/** An agent's Send to a Remote Origin in the conversation: the Origin Approval card, answered there. */
import "../../../test/dom.testing.ts";
import "../../../app/slots.tsx";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { fixtureOriginApproval } from "../../requests/preview/approvalFixtures.ts";
import { fixtureAppState, HOST } from "../../traces/preview/appState.ts";
import { FIXTURE_CHECKOUT, FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { ConversationRow, type RowContext } from "./rows.tsx";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const shown: Pick<RowContext, "harness" | "diff"> = {
  harness: "claude",
  diff: { hostKey: HOST, cwd: FIXTURE_CHECKOUT.checkout, sessionId: FIXTURE_SESSION },
};

// SAFETY: an approval row reads only `diff` (where it is) and `harness` from its context.
const ctx = shown as RowContext;

test("an Origin Approval in the conversation is the Origin Approval card, and Approve answers it", async () => {
  const store = createStore<AppState>(() => fixtureAppState());

  const connection: Connection = {
    store,
    openSession: () => () => undefined,
    setDensity: () => undefined,
    setAppearance: () => undefined,
  };

  const request = fixtureOriginApproval(FIXTURE_SESSION, "r-thread-origin");

  render(
    <AppProvider
      value={{
        connection,
        navigation: createNavigation({ app: store, storage: null }),
        commands: createCommandRegistry({ platform: "mac" }),
      }}
    >
      <ConversationRow
        row={{ kind: "approval", key: request.id, request, settled: null, wrote: null }}
        ctx={ctx}
      />
    </AppProvider>
  );

  const card = screen.getByTestId("origin-approval");

  expect(card.textContent).toContain("Fix overdue totals wants to POST /invoices/overdue there.");
  expect(card.textContent).toContain("Remembered on Mac Studio");
  fireEvent.click(within(card).getByTestId("origin-approval-approve"));

  await waitFor(() =>
    expect(
      bridge
        .sent("dispatch")
        .flatMap(({ command }) =>
          Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
        )
    ).toEqual([Decisions.Allow({ remember: true, originScope: "reads-and-writes" })])
  );
});
