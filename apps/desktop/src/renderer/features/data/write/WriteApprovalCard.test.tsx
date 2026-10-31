import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApprovalRequest } from "@polaris/protocol";
import { Predicate } from "effect";
import { Decisions } from "../../../commands.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { deny } from "../../needs-you/respond.ts";
import { FIXTURE_SOURCES } from "../preview/fixtures.ts";
import { fixtureWrite, fixtureWriteApproval, worstWrite } from "../preview/writeFixtures.ts";
import type { DataWrite } from "./model.ts";
import { WriteApprovalCard } from "./WriteApprovalCard.tsx";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

const [APP, BRANCH] = FIXTURE_SOURCES;

const card = (request: ApprovalRequest, source = APP) => (
  <WriteApprovalCard
    hostKey="local"
    request={request}
    // SAFETY: fixtureWriteApproval always carries a dataWrite.
    write={request.dataWrite as DataWrite}
    who="Backfill currency"
    source={source}
    outcome={null}
    entry={undefined}
  />
);

const decisions = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
    );

test("Run sends one Allow, never remembered, and the card collapses to what ran", async () => {
  render(card(fixtureWriteApproval()));

  expect(screen.getByTestId("data-write-kicker").textContent).toBe(
    "Dry run · rolled back · 214 rows"
  );
  fireEvent.click(screen.getByTestId("data-write-run"));

  await waitFor(() => expect(decisions()).toEqual([Decisions.Allow({ remember: false })]));
  expect(screen.getByTestId("data-write-settled").textContent).toBe("Allowed 214-row update");
});

test("⌘↵ in the card runs it", async () => {
  render(card(fixtureWriteApproval()));

  fireEvent.keyDown(screen.getByTestId("data-write-run"), { key: "Enter", metaKey: true });

  await waitFor(() => expect(decisions()).toEqual([Decisions.Allow({ remember: false })]));
});

test("Deny needs a reason, and the reason is what the agent gets", async () => {
  render(card(fixtureWriteApproval()));

  fireEvent.click(screen.getByTestId("data-write-deny-open"));
  const send = screen.getByTestId("data-write-deny-send");

  expect(send.hasAttribute("disabled")).toBe(true);
  fireEvent.click(send);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(decisions()).toEqual([]);

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Use EUR for 2025  " } });
  fireEvent.click(screen.getByTestId("data-write-deny-send"));

  await waitFor(() =>
    expect(decisions()).toEqual([Decisions.Deny({ reason: "Use EUR for 2025" })])
  );
  expect(screen.getByTestId("data-write-settled").textContent).toBe("Denied: Use EUR for 2025");
});

test("Deny from the inbox, ⌘⇧D or a notification opens the reason field and sends nothing", async () => {
  const request = fixtureWriteApproval();
  let opened = false;

  render(card(request));
  expect(screen.queryByRole("textbox")).toBeNull();

  const sent = await act(() =>
    deny({ hostKey: "local", sessionId: request.sessionId, request }, () => {
      opened = true;
    })
  );

  expect(sent).toBe(false);
  expect(opened).toBe(true);
  expect(decisions()).toEqual([]);
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});

test("a remote source's card takes its label colour on the top bar; a local one has none", () => {
  const { unmount } = render(card(fixtureWriteApproval(), APP));

  expect(screen.queryByTestId("data-write-bar")).toBeNull();
  unmount();

  render(card(fixtureWriteApproval(fixtureWrite({ target: worstWrite().target })), BRANCH));
  expect(screen.getByTestId("data-write-bar").getAttribute("data-colour")).toBe("tan");
});

test("the worst case shows the changed columns, 20 of the rows, and offers the rest", () => {
  render(card(fixtureWriteApproval(worstWrite()), BRANCH));

  const rows = screen.getByTestId("data-write-rows");

  expect(rows.querySelectorAll("tbody tr")).toHaveLength(40);
  expect(rows.querySelectorAll("thead th").length).toBeLessThanOrEqual(13);
  expect(screen.getByText("showing 20 of 1,204,118")).toBeTruthy();
  fireEvent.click(screen.getByText("Show all 256 columns"));
  expect(rows.querySelectorAll("thead th")).toHaveLength(257);
  expect(screen.getByText("Show the whole statement")).toBeTruthy();
});
