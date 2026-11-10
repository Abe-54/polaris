import { ApprovalRequest, RequestId, SessionId, TurnId } from "@polaris/protocol";
import { expect, test } from "bun:test";
import { offersAlwaysAllow } from "./decide.ts";

const of = (kind: ApprovalRequest["kind"]) =>
  new ApprovalRequest({
    id: RequestId.make("r1"),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("t1"),
    kind,
    title: "t",
    detail: null,
    options: [],
    openedAt: "2026-11-10T12:00:00.000Z",
  });

// The inbox, hover card and constellation rows offer "Always here" from this.
test("headed input is never offered Always allow; an app and a command are", () => {
  expect(offersAlwaysAllow(of("headed-input"))).toBe(false);
  expect(offersAlwaysAllow(of("app"))).toBe(true);
  expect(offersAlwaysAllow(of("command"))).toBe(true);
});
