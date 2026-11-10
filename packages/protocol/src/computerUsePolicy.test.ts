/** The rules of ADR 0104 by name; the model-based test in the Daemon covers their interleavings. */
import { describe, expect, test } from "bun:test";
import { AppId } from "./computerUse.ts";
import {
  answerAppApproval,
  appDecisionRefusal,
  AppUseDecision,
  controlApp,
  decideAppUse,
  emptyAppPolicy,
  forgetSession,
  releaseSession,
  withoutAllowedApp,
} from "./computerUsePolicy.ts";
import { ApprovalDecision } from "./domain.ts";
import { Actor } from "./extensions.ts";
import { LinkedDeviceId, PairingId, SessionId } from "./ids.ts";

const figma = AppId.make("com.figma.Desktop");

const keychain = AppId.make("com.apple.keychainaccess");

const [one, two] = [SessionId.make("s1"), SessionId.make("s2")];

const allow = (remember: boolean) => ApprovalDecision.cases.Allow.make({ remember });

const deny = ApprovalDecision.cases.Deny.make({ reason: null });

const use = (sessionId: SessionId, appId: AppId, headed = false) => ({ sessionId, appId, headed });

const { Allowed, InUse, NeedsApproval, Refused } = AppUseDecision.cases;

const app = (sessionId: SessionId, appId = figma) => ({ sessionId, appId, kind: "app" as const });

const headed = (sessionId: SessionId) => ({
  sessionId,
  appId: figma,
  kind: "headed-input" as const,
});

describe("app approvals", () => {
  test("an app needs an approval per session; allowing it for one session leaves the other asking", () => {
    const policy = answerAppApproval(emptyAppPolicy(), app(one), allow(false));

    expect(decideAppUse(emptyAppPolicy(), use(one, figma))).toEqual(
      NeedsApproval.make({ kind: "app" })
    );
    expect(decideAppUse(policy, use(one, figma))).toEqual(Allowed.make({}));
    expect(decideAppUse(policy, use(two, figma))).toEqual(NeedsApproval.make({ kind: "app" }));
  });

  test("always allow covers every session on the Host until it is removed", () => {
    const always = answerAppApproval(emptyAppPolicy(), app(one), allow(true));

    expect(decideAppUse(always, use(two, figma))).toEqual(Allowed.make({}));

    const removed = withoutAllowedApp(always, figma);

    expect([one, two].map((s) => decideAppUse(removed, use(s, figma)))).toEqual([
      NeedsApproval.make({ kind: "app" }),
      NeedsApproval.make({ kind: "app" }),
    ]);
  });

  test("a denied app asks again the next time", () => {
    const policy = answerAppApproval(emptyAppPolicy(), app(one), deny);

    expect(decideAppUse(policy, use(one, figma))).toEqual(NeedsApproval.make({ kind: "app" }));
  });

  test("an always-refused app is refused even when allowed", () => {
    const listed = emptyAppPolicy([keychain], [keychain]);
    const policy = answerAppApproval(listed, app(one, keychain), allow(false));

    expect(decideAppUse(policy, use(one, keychain))).toEqual(Refused.make({}));
    expect(controlApp(policy, use(one, keychain)).controllers.size).toBe(0);
  });

  test("an archived session's approvals go with it", () => {
    const policy = answerAppApproval(emptyAppPolicy(), app(one), allow(false));

    expect(decideAppUse(forgetSession(policy, one), use(one, figma))).toEqual(
      NeedsApproval.make({ kind: "app" })
    );
  });
});

describe("headed input", () => {
  const allowed = answerAppApproval(emptyAppPolicy(), app(one), allow(true));

  test("needs its own approval after the app's, per session", () => {
    expect(decideAppUse(emptyAppPolicy(), use(one, figma, true))).toEqual(
      NeedsApproval.make({ kind: "app" })
    );
    expect(decideAppUse(allowed, use(one, figma, true))).toEqual(
      NeedsApproval.make({ kind: "headed-input" })
    );

    const policy = answerAppApproval(allowed, headed(one), allow(false));

    expect(decideAppUse(policy, use(one, figma, true))).toEqual(Allowed.make({}));
    expect(decideAppUse(policy, use(two, figma, true))).toEqual(
      NeedsApproval.make({ kind: "headed-input" })
    );
  });

  test("is never always-allowed: the answer is refused and grants nothing", () => {
    expect(appDecisionRefusal("headed-input", allow(true))).toBe(
      "Headed input can only be allowed for this session"
    );
    expect(answerAppApproval(allowed, headed(one), allow(true))).toEqual(allowed);
  });
});

describe("one session per app", () => {
  const policy = controlApp(answerAppApproval(emptyAppPolicy(), app(one), allow(true)), {
    ...use(one, figma),
  });

  test("another session is told who has the app until that Turn ends", () => {
    expect(decideAppUse(policy, use(two, figma))).toEqual(InUse.make({ by: one }));
    expect(decideAppUse(policy, use(one, figma))).toEqual(Allowed.make({}));
    expect(decideAppUse(releaseSession(policy, one), use(two, figma))).toEqual(Allowed.make({}));
  });

  test("asking for an app takes no control of it", () => {
    const asked = controlApp(emptyAppPolicy(), use(one, figma));

    expect(asked.controllers.size).toBe(0);
  });
});

describe("who may always allow an app", () => {
  const extension = Actor.cases.Extension.make({ pairingId: PairingId.make("p1"), name: "G2" });

  const device = Actor.cases.LinkedDevice.make({
    deviceId: LinkedDeviceId.make("d1"),
    name: "iPhone",
  });

  test("an Extension allows an app for the session, never for the Host", () => {
    expect(appDecisionRefusal("app", allow(false), extension)).toBeNull();
    expect(appDecisionRefusal("app", deny, extension)).toBeNull();
    expect(appDecisionRefusal("app", allow(true), extension)).toBe(
      "An extension can only allow an app for this session"
    );
  });

  test("the Desktop App and a Linked Device always allow", () => {
    expect(
      [Actor.cases.Client.make({}), device, null].map((actor) =>
        appDecisionRefusal("app", allow(true), actor)
      )
    ).toEqual([null, null, null]);
  });
});

describe("which decisions answer a computer use approval", () => {
  const answer = ApprovalDecision.cases.Answer.make({ text: "yes" });
  const provided = ApprovalDecision.cases.Provided.make({});

  test.each([
    ["app", allow(false), null],
    ["app", allow(true), null],
    ["app", deny, null],
    ["headed-input", allow(false), null],
    ["headed-input", deny, null],
    ["app", answer, "Allow or deny this app"],
    ["headed-input", provided, "Allow or deny this app"],
    // Not a computer use approval: this rule has nothing to say.
    ["command", answer, null],
  ] as const)("%s answered with %o", (kind, decision, refusal) => {
    expect(appDecisionRefusal(kind, decision)).toBe(refusal);
  });
});
