import { describe, expect, test } from "bun:test";
import { ApprovalDecision, Command, RequestId, SessionId } from "@polaris/protocol";
import { answerOf, DEFAULT_ACTION, PUSH_CATEGORIES, PushAction, routeOf } from "./answer.ts";

const approval = {
  polaris: { kind: "needs-you", hostId: "h1", sessionId: "s1", requestId: "r1" },
};

const respond = (
  actionIdentifier: string,
  userInfo: ReadonlyArray<unknown> = [approval],
  category: string | null = "approval"
) => answerOf({ actionIdentifier, category, userInfo });

describe("the approval category", () => {
  test("offers Approve, Always here and Deny, Deny destructive, each behind authentication", () => {
    const approvalCategory = PUSH_CATEGORIES.find((category) => category.identifier === "approval");

    expect(
      approvalCategory?.actions.map((a) => [
        a.buttonTitle,
        a.options.isDestructive,
        a.options.isAuthenticationRequired,
        a.options.opensAppToForeground,
      ])
    ).toEqual([
      ["Approve", false, true, false],
      ["Always here", false, true, false],
      ["Deny", true, true, false],
    ]);
  });
});

describe("answers from a notification", () => {
  test.each([
    [PushAction.approve, ApprovalDecision.cases.Allow.make({ remember: false })],
    [PushAction.always, ApprovalDecision.cases.Allow.make({ remember: true })],
    [PushAction.deny, ApprovalDecision.cases.Deny.make({ reason: null })],
  ])("%s answers the request on its Host", (action, decision) => {
    const answer = respond(action);

    expect(answer?.hostId).toBe("h1");
    expect(answer?.dispatch.command).toEqual(
      Command.cases.RespondToApproval.make({
        sessionId: SessionId.make("s1"),
        requestId: RequestId.make("r1"),
        decision,
      })
    );
  });

  test("the same request answered twice is one command", () => {
    expect(respond(PushAction.approve)?.dispatch.commandId).toBe(
      respond(PushAction.deny)?.dispatch.commandId
    );
  });

  test("the target is found in the push payload when data doesn't carry it", () => {
    expect(respond(PushAction.approve, [{}, { aps: {}, ...approval }])?.hostId).toBe("h1");
  });

  test.each([
    ["a secret's push (category question)", "question"],
    ["a push with no category", null],
  ])("an action on %s never answers it", (_, category) => {
    for (const action of Object.values(PushAction))
      expect(respond(action, [approval], category)).toBeNull();
  });

  test("a tap, a finished Turn or an unopened push answers nothing", () => {
    expect(respond("expo.modules.notifications.actions.DEFAULT")).toBeNull();

    const turnEnded = { polaris: { ...approval.polaris, kind: "turn-ended", requestId: null } };
    expect(respond(PushAction.approve, [turnEnded])).toBeNull();
    // The extension couldn't open it: only the generic alert and the sealed payload.
    expect(respond(PushAction.approve, [{ p: "c2VhbGVk" }])).toBeNull();
  });
});

describe("opening a notification", () => {
  const tap = (polaris: Partial<Record<string, string | null>>, action = DEFAULT_ACTION) =>
    routeOf({
      actionIdentifier: action,
      category: "question",
      userInfo: [{ polaris: { ...approval.polaris, ...polaris } }],
    });

  test("a notification about a constellation opens the constellation", () => {
    expect(tap({ kind: "notify", requestId: null, constellationId: "c1" })).toEqual({
      screen: "constellation",
      hostId: "h1",
      constellationId: "c1",
    });
  });

  test.each([
    ["an agent's notify", { kind: "notify", requestId: null, constellationId: null }],
    ["a finished Turn", { kind: "turn-ended", requestId: null }],
    ["a secret request", { kind: "needs-you", requestId: "r1" }],
  ])("%s opens its session", (_, polaris) => {
    expect(tap(polaris)).toEqual({ screen: "thread", hostId: "h1", sessionId: "s1" });
  });

  test("an action button opens nothing", () => {
    expect(tap({}, PushAction.approve)).toBeNull();
  });
});

test("P9-10: attach notification offers and accepts only one-time approval or denial", () => {
  expect(
    PUSH_CATEGORIES.find((c) => c.identifier === "approval-once")?.actions.map((a) => a.identifier)
  ).toEqual([PushAction.approve, PushAction.deny]);
  expect(respond(PushAction.always, [approval], "approval-once")).toBeNull();
  expect(respond(PushAction.approve, [approval], "approval-once")?.dispatch.command).toMatchObject({
    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
  });
  expect(respond(PushAction.deny, [approval], "approval-once")?.dispatch.command).toMatchObject({
    decision: ApprovalDecision.cases.Deny.make({ reason: null }),
  });
});
