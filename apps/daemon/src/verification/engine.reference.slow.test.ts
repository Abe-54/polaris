/**
 * The reference decider on its own, for cases the model-based test once got
 * wrong. B1 (M2 validation): with seed 1928205926 the reference refused a
 * Retry after its Failed Turn was accepted, which the Engine and the spec allow.
 */
import { describe, expect, test } from "bun:test";
import { Command, SessionId } from "@polaris/protocol";
import { referenceDecide, type View } from "./engine.reference.testing.ts";

const sessionId = SessionId.make("s1");

const accepted = (status: "interrupted" | "failed", state: string): View => ({
  state,
  autonomous: false,
  turns: new Map([["t1", status]]),
  order: ["t1"],
  pending: new Set(),
  accepted: 0,
});

describe("the reference decider after AcceptTurns", () => {
  test("Retry of an accepted Failed Turn starts a new Turn", () => {
    expect(
      referenceDecide(accepted("failed", "failed"), Command.cases.Retry.make({ sessionId }), "mac")
    ).toEqual(["TurnStarted:working", "state:starting"]);
  });

  test("Continue of an accepted Interrupted Turn is refused", () => {
    expect(
      referenceDecide(
        accepted("interrupted", "needs-you"),
        Command.cases.Continue.make({ sessionId }),
        "mac"
      )
    ).toBe("reject");
  });
});
