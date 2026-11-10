import {
  AppId,
  ApprovalRequest,
  DesktopApp,
  RequestId,
  SessionId,
  TurnId,
} from "@polaris/protocol";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";
import { AppApprovalCard } from "./AppApprovalCard.tsx";

afterEach(cleanup);

const request = (kind: "app" | "headed-input") =>
  new ApprovalRequest({
    id: RequestId.make("r1"),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    kind,
    app: new DesktopApp({
      id: AppId.make("com.apple.iphonesimulator"),
      name: "Simulator",
      icon: null,
    }),
    title: "Use Simulator",
    detail: "To check the booking flow in Trips",
    options: [],
    openedAt: "2026-11-10T12:00:00.000Z",
  });

const show = (kind: "app" | "headed-input") => {
  const answers: Array<string> = [];

  render(
    <AppApprovalCard
      request={request(kind)}
      who="Claude Code"
      host="Mac Studio"
      onAllow={() => answers.push("once")}
      onAlwaysAllow={() => answers.push("always")}
      onDeny={() => answers.push("deny")}
    />
  );

  return { page: within(document.body), answers };
};

describe("a computer use approval in the transcript (CU4)", () => {
  test("an app approval names the app and offers once, always on the Host, and deny", () => {
    const { page, answers } = show("app");

    expect(page.getByText("Claude Code wants to use Simulator")).toBeTruthy();
    expect(page.getByText("To check the booking flow in Trips")).toBeTruthy();

    for (const label of ["Allow once", "Always allow on Mac Studio", "Deny"])
      act(() => void fireEvent.click(page.getByText(label)));
    expect(answers).toEqual(["once", "always", "deny"]);
  });

  test("headed input is once or deny, never always, and says how to take over", () => {
    const { page } = show("headed-input");

    expect(page.getByText("Claude Code wants your mouse and keyboard")).toBeTruthy();
    expect(page.queryByText(/Always allow/)).toBeNull();
    expect(page.getByText(/Touch the mouse or keyboard to take over/)).toBeTruthy();
    expect(page.getByText("Asked each time it's needed.")).toBeTruthy();
  });
});
