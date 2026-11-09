import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ApprovalRequest, OriginApproval } from "@polaris/protocol";
import { Predicate } from "effect";
import { Decisions } from "../../../commands.ts";
import { type FakeBridge, installFakeBridge } from "../../../test/bridge.testing.ts";
import { standInBridge } from "../../bridge.ts";
import { allowFor, offersAlwaysAllow } from "../../data/approval/decide.ts";
import { FIXTURE_SESSION } from "../../traces/preview/fixtures.ts";
import { fixtureOriginApproval, STAGING_GET, STAGING_POST } from "../preview/approvalFixtures.ts";
import { OriginApprovalCard } from "./OriginApprovalCard.tsx";

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
const fresh = (origin: OriginApproval = STAGING_POST) =>
  fixtureOriginApproval(FIXTURE_SESSION, `r-origin-${++next}`, origin);

const card = (request: ApprovalRequest) => (
  <OriginApprovalCard
    hostKey="local"
    request={request}
    target={request.origin ?? STAGING_POST}
    who="Fix overdue totals"
    turn={12}
    hostLabel="Mac Studio"
  />
);

const decisions = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
    );

const checked = () =>
  screen.getAllByRole<HTMLInputElement>("radio").flatMap((r) => (r.checked ? [r.value] : []));

test("it names the origin's host, the send, where the URL and token came from, never a value", () => {
  render(card(fresh()));

  expect(screen.getByRole("heading").textContent).toBe("Let agents send to staging.ledger.dev?");
  expect(screen.getByTestId("origin-approval").textContent).toContain(
    "Fix overdue totals wants to POST /invoices/overdue there. It isn't on this host, so no agent can send to it until you approve it."
  );
  expect(
    [...screen.getByTestId("origin-approval-target").querySelectorAll("div")].map(
      (row) => row.textContent
    )
  ).toEqual([
    "Originhttps://staging.ledger.dev",
    "From{{base}} · env staging",
    "SendPOST /invoices/overdue · a write",
    "ByFix overdue totals · turn 12",
    "Token.env.local · LEDGER_TOKEN",
  ]);
  expect(screen.getByTestId("origin-approval").textContent).toContain("Remembered on Mac Studio");
});

test("a write pre-selects Reads and writes and says Reads only denies it; a read pre-selects Reads only", () => {
  render(card(fresh()));

  expect(checked()).toEqual(["reads-and-writes"]);
  expect(screen.getByTestId("origin-approval").textContent).toContain(
    "For this origin only. Reads only denies this send. Agents never see the token."
  );
  cleanup();

  render(card(fresh(STAGING_GET)));

  expect(checked()).toEqual(["reads"]);
  expect(screen.getByTestId("origin-approval").textContent).not.toContain("denies");
});

test("Approve remembers the origin with the scope shown; Deny denies", async () => {
  render(card(fresh()));
  fireEvent.click(screen.getByTestId("origin-approval-approve"));
  await waitFor(() =>
    expect(decisions()).toEqual([
      Decisions.Allow({ remember: true, originScope: "reads-and-writes" }),
    ])
  );
  cleanup();

  render(card(fresh()));
  fireEvent.click(screen.getByRole("radio", { name: /Reads only/ }));
  fireEvent.click(screen.getByTestId("origin-approval-approve"));
  await waitFor(() =>
    expect(decisions().at(-1)).toEqual(Decisions.Allow({ remember: true, originScope: "reads" }))
  );
  cleanup();

  render(card(fresh()));
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(decisions().at(-1)).toEqual(Decisions.Deny({ reason: null })));
});

test("the thread's card and Requests' share the scope, and answering one settles both", async () => {
  const request = fresh();

  render(
    <>
      {card(request)}
      {card(request)}
    </>
  );
  const [first] = screen.getAllByRole("radio", { name: /Reads only/ });

  if (first === undefined) throw new Error("no scope");
  fireEvent.click(first);
  expect(checked()).toEqual(["reads", "reads"]);

  const [approve] = screen.getAllByTestId("origin-approval-approve");

  if (approve === undefined) throw new Error("no Approve");
  fireEvent.click(approve);

  expect(screen.queryAllByTestId("origin-approval-approve")).toHaveLength(0);
  expect(screen.getAllByTestId("origin-approval-settled").map((s) => s.textContent)).toEqual([
    "Approved. Agents can send to it now.",
    "Approved. Agents can send to it now.",
  ]);
  await waitFor(() =>
    expect(decisions()).toEqual([Decisions.Allow({ remember: true, originScope: "reads" })])
  );
});

test("the inbox and hover cards offer no Always allow, and Approve sends what the send needs", () => {
  expect(offersAlwaysAllow(fresh())).toBe(false);
  expect(allowFor(fresh(), false)).toEqual(
    Decisions.Allow({ remember: true, originScope: "reads-and-writes" })
  );
  expect(allowFor(fresh(STAGING_GET), false)).toEqual(
    Decisions.Allow({ remember: true, originScope: "reads" })
  );
});
