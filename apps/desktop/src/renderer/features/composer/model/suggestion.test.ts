import { SuggestedReply, type SessionState, TurnId } from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { offeredReply } from "./suggestion.ts";

const T1 = TurnId.make("t1");

const reply = SuggestedReply.make({ turnId: T1, text: "go with B", source: "harness" });

describe("offeredReply (ENG-885)", () => {
  test("an Idle session offers its latest Turn's reply", () => {
    expect(offeredReply("idle", reply, T1)).toEqual({ turnId: T1, text: "go with B" });
  });

  test.each<SessionState>(["working", "needs-you", "limited", "starting", "failed", "dormant"])(
    "hidden while %s",
    (state) => {
      expect(offeredReply(state, reply, T1)).toBeNull();
    }
  );

  test("hidden once a newer Turn starts, from any Client", () => {
    expect(offeredReply("idle", reply, TurnId.make("t2"))).toBeNull();
  });

  test("nothing without an event, or with blank text", () => {
    expect(offeredReply("idle", null, T1)).toBeNull();
    expect(
      offeredReply("idle", SuggestedReply.make({ turnId: T1, text: "  \n", source: "harness" }), T1)
    ).toBeNull();
  });
});
