import {
  AppId,
  ApprovalRequest,
  DesktopApp,
  RequestId,
  SessionId,
  TurnId,
} from "@polaris/protocol";
import { describe, expect, test } from "bun:test";
import { computerUseView } from "./approval.ts";

const base = (kind: "app" | "headed-input") => ({
  id: RequestId.make("r1"),
  sessionId: SessionId.make("s1"),
  turnId: TurnId.make("t1"),
  kind,
  title: "Use Simulator",
  options: [],
  openedAt: "2026-11-10T12:00:00.000Z",
});

const simulator = new DesktopApp({
  id: AppId.make("com.apple.iphonesimulator"),
  name: "Simulator",
  icon: null,
});

const view = (request: ApprovalRequest) => computerUseView(request, "Claude Code", "Mac Studio");

describe("a computer use approval on the phone (CU4)", () => {
  test("an app approval asks to use the app, with once, always on the Host, and deny", () => {
    const shown = view(
      new ApprovalRequest({ ...base("app"), app: simulator, detail: "To check the booking flow" })
    );

    expect(shown.title).toBe("Use Simulator?");
    expect(shown.who).toBe("Claude Code · on Mac Studio");
    expect(shown.reason).toBe("To check the booking flow");
    expect(shown.answers.map((a) => [a.label, a.reply.kind])).toEqual([
      ["Allow once", "approve"],
      ["Always allow on Mac Studio", "always"],
      ["Deny", "deny"],
    ]);
  });

  test("headed input is once or deny, and says how to take over", () => {
    const shown = view(
      new ApprovalRequest({ ...base("headed-input"), app: simulator, detail: null })
    );

    expect(shown.title).toBe("Take mouse and keyboard?");
    expect(shown.answers.map((a) => a.reply.kind)).toEqual(["approve", "deny"]);
    expect(shown.takeOver).toContain("Touch the mouse or keyboard on Mac Studio to take over");
  });

  test("without an app on the request, it still names one and shows the title", () => {
    const shown = view(new ApprovalRequest({ ...base("app"), detail: null }));

    expect(shown.title).toBe("Use an app?");
    expect(shown.reason).toBe("Use Simulator");
  });
});
