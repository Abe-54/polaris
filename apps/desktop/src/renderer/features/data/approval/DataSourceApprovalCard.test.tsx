import "../../../test/dom.testing.ts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "bun:test";
import type { ApprovalDecision } from "@polaris/protocol";
import { Decisions } from "../../../commands.ts";
import { FIXTURE_DATA_APPROVAL } from "../preview/fixtures.ts";
import { DataSourceApprovalCard } from "./DataSourceApprovalCard.tsx";
import { dataSourceTarget } from "./model.ts";

afterEach(cleanup);

const mount = () => {
  const decided: ApprovalDecision[] = [];
  const target = dataSourceTarget(FIXTURE_DATA_APPROVAL);

  if (target === null) throw new Error("the fixture is a Data Source Approval");
  render(
    <DataSourceApprovalCard
      target={target}
      who="Backfill currency"
      hostLabel="Mac Studio"
      onDecide={(d) => decided.push(d)}
    />
  );

  return decided;
};

test("it names the target and the Host that remembers it", () => {
  mount();

  expect(screen.getByRole("heading").textContent).toBe("Let agents read analytics?");
  expect(screen.getByTestId("data-approval-target").textContent).toContain("backfill-currency");
  expect(screen.getByTestId("data-approval").textContent).toContain("Remembered on Mac Studio");
});

test("Approve sends the scope chosen: this database by default, or the whole server", () => {
  const decided = mount();

  fireEvent.click(screen.getByTestId("data-approval-approve"));
  fireEvent.click(screen.getByRole("radio", { name: /Every database on this server/ }));
  fireEvent.click(screen.getByTestId("data-approval-approve"));

  expect(decided).toEqual([
    Decisions.Allow({ remember: true, dataScope: "target" }),
    Decisions.Allow({ remember: true, dataScope: "server" }),
  ]);
});

test("Deny denies", () => {
  const decided = mount();

  fireEvent.click(screen.getByRole("button", { name: "Deny" }));

  expect(decided).toEqual([Decisions.Deny({ reason: null })]);
});
