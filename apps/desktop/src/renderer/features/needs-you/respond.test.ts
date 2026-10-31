import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ApprovalRequest, SessionId, TurnId } from "@polaris/protocol";
import { Predicate } from "effect";
import { Decisions } from "../../commands.ts";
import { type FakeBridge, installFakeBridge } from "../../test/bridge.testing.ts";
import { standInBridge } from "../bridge.ts";
import { setApprovalScope } from "../data/approval/decide.ts";
import { fixtureDataApproval } from "../data/preview/fixtures.ts";
import { onNeedsYouEvent } from "./bridge.ts";
import { approve } from "./respond.ts";

let bridge: FakeBridge;

beforeEach(() => {
  bridge = installFakeBridge();
});

afterEach(() => standInBridge(null));

const sessionId = SessionId.make("s-backfill");

let next = 0;

const data = (): ApprovalRequest =>
  fixtureDataApproval(sessionId, TurnId.make("turn-5"), undefined, { id: `r-respond-${++next}` });

const decisions = () =>
  bridge
    .sent("dispatch")
    .flatMap(({ command }) =>
      Predicate.isTagged(command, "RespondToApproval") ? [command.decision] : []
    );

const actions = { selectSession: () => undefined, showSidebar: () => undefined };

describe("Approve from the inbox, a hover card or a notification (F4)", () => {
  test.each([false, true])(
    "a Data Source Approval sends its card's scope, remembered (asked to remember: %p)",
    async (remember) => {
      const request = data();

      setApprovalScope(request.id, "server");
      await approve({ hostKey: "local", sessionId, request }, remember);

      expect(decisions()).toEqual([Decisions.Allow({ remember: true, dataScope: "server" })]);
    }
  );

  test("its default is this database, as the card's is", async () => {
    await approve({ hostKey: "local", sessionId, request: data() });

    expect(decisions()).toEqual([Decisions.Allow({ remember: true, dataScope: "target" })]);
  });

  test("a notification's Approve finds the request and answers it the same way", async () => {
    const request = data();

    setApprovalScope(request.id, "server");
    onNeedsYouEvent(
      { kind: "needs-you", action: "approve", hostKey: "local", sessionId, requestId: request.id },
      actions,
      (_host, _session, id) => (id === request.id ? request : undefined)
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decisions()).toEqual([Decisions.Allow({ remember: true, dataScope: "server" })]);
  });

  test("a notification for a request already resolved answers nothing", async () => {
    onNeedsYouEvent(
      { kind: "needs-you", action: "approve", hostKey: "local", sessionId, requestId: "r-gone" },
      actions,
      () => undefined
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decisions()).toEqual([]);
  });
});
