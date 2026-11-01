import "../../../test/dom.testing.ts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type ApprovalRequest, TurnId } from "@polaris/protocol";
import { Predicate } from "effect";
import { Decisions } from "../../../commands.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { FIXTURE_SESSIONS, fixtureDataApproval } from "../preview/fixtures.ts";
import { DataSourceApprovalCard } from "./DataSourceApprovalCard.tsx";
import { dataSourceTarget } from "./model.ts";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => {
  cleanup();
  standInBridge(null);
});

let next = 0;

/** A fresh request each test: what one decided stays decided in every view. */
const fresh = (): ApprovalRequest =>
  fixtureDataApproval(FIXTURE_SESSIONS.backfill.id, TurnId.make("turn-5"), undefined, {
    id: `r-card-${++next}`,
  });

const card = (request: ApprovalRequest, alreadyApproved = false) => {
  const target = dataSourceTarget(request);

  if (target === null) throw new Error("the fixture is a Data Source Approval");

  return (
    <DataSourceApprovalCard
      hostKey="local"
      request={request}
      target={target}
      who="Backfill currency"
      hostLabel="Mac Studio"
      alreadyApproved={alreadyApproved}
    />
  );
};

const decisions = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
    );

test("it names the target, who asks in glossary words, and the Host that remembers it", () => {
  render(card(fresh()));

  expect(screen.getByRole("heading").textContent).toBe("Let agents read analytics?");
  expect(screen.getByTestId("data-approval").textContent).toContain(
    "Backfill currency wants to read analytics. No agent can reach it until you approve it."
  );
  expect(screen.getByTestId("data-approval-target").textContent).toContain("backfill-currency");
  expect(screen.getByTestId("data-approval").textContent).toContain("Remembered on Mac Studio");
});

test("Approve sends the scope chosen, remembered", async () => {
  render(card(fresh()));

  fireEvent.click(screen.getByRole("radio", { name: /Every database on this server/ }));
  fireEvent.click(screen.getByTestId("data-approval-approve"));

  await waitFor(() =>
    expect(decisions()).toEqual([Decisions.Allow({ remember: true, dataScope: "server" })])
  );
});

test("Deny denies", async () => {
  render(card(fresh()));

  fireEvent.click(screen.getByRole("button", { name: "Deny" }));

  await waitFor(() => expect(decisions()).toEqual([Decisions.Deny({ reason: null })]));
});

test("two views of one request share the scope, and a decision in one settles both (F3)", async () => {
  const request = fresh();

  render(
    <>
      {card(request)}
      {card(request)}
    </>
  );
  const [first] = screen.getAllByRole("radio", { name: /Every database on this server/ });

  if (first === undefined) throw new Error("no scope");
  fireEvent.click(first);

  expect(
    screen
      .getAllByRole<HTMLInputElement>("radio", { name: /Every database on this server/ })
      .map((r) => r.checked)
  ).toEqual([true, true]);

  const [approve] = screen.getAllByTestId("data-approval-approve");

  if (approve === undefined) throw new Error("no Approve");
  fireEvent.click(approve);

  expect(screen.queryAllByTestId("data-approval-approve")).toHaveLength(0);
  expect(screen.getAllByTestId("data-approval-settled").map((s) => s.textContent)).toEqual([
    "Approved. Agents can read it now.",
    "Approved. Agents can read it now.",
  ]);
  await waitFor(() => expect(decisions()).toHaveLength(1));
});

test("a request for a target approved already settles itself, once (F3)", async () => {
  const request = fresh();

  render(card(request, true));

  expect(screen.getByTestId("data-approval-settled").textContent).toBe(
    "Approved. Agents can read it now."
  );
  await waitFor(() =>
    expect(decisions()).toEqual([Decisions.Allow({ remember: true, dataScope: "target" })])
  );
});

test("a refused answer opens the card again, and an automatic one isn't retried", async () => {
  bridge.refuse("dispatch", { code: "CommandRejected", message: "no such request" });
  const request = fresh();

  render(card(request, true));

  await waitFor(() => expect(screen.queryByTestId("data-approval-approve")).not.toBeNull());
  await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  expect(decisions()).toHaveLength(1);
});
