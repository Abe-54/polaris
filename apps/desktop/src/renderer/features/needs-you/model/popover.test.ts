import { describe, expect, test } from "bun:test";
import { ApprovalRequest, RequestId, SessionId, TurnId } from "@polaris/protocol";
import type { WaitingSession } from "./inbox.ts";
import { sessionWith } from "./inbox.testing.ts";
import { fixtureDataApproval } from "../../data/preview/fixtures.ts";
import { toSummary } from "./summary.ts";
import { waitingCopy } from "./popover.ts";

const waiting = (pending: ApprovalRequest): WaitingSession => ({
  key: "local:s1",
  hostKey: "local",
  hostLabel: "Mac Studio",
  workspace: "polaris",
  branch: "main",
  entry: {
    session: sessionWith("s1", { title: "Spike" }),
    pendingApprovals: [pending],
    lastTurnPreview: null,
    subagents: [],
  },
  requests: [pending],
  since: pending.openedAt,
});

const withDetail = (kind: ApprovalRequest["kind"], detail: string | null) =>
  new ApprovalRequest({
    id: RequestId.make("r1"),
    sessionId: SessionId.make("s1"),
    turnId: TurnId.make("s1-t1"),
    kind,
    title: "Run bun test",
    detail,
    options: [],
    openedAt: "2026-10-28T20:00:00.000Z",
  });

describe("waitingCopy", () => {
  test.each([
    ["command", "rm -rf build && cargo build --release -p review-spike"],
    ["file-change", "apps/desktop/src/main/index.ts: +12 −3"],
    ["tool", "github.create_pull_request({ base: 'main' })"],
  ] as const)("a %s approval shows the whole request it answers", (kind, detail) => {
    expect(waitingCopy(waiting(withDetail(kind, detail)), Date.now())?.code).toBe(detail);
  });

  test("without a detail, the request's title stands in", () => {
    expect(waitingCopy(waiting(withDetail("tool", null)), Date.now())?.code).toBe("Run bun test");
  });

  test("a question is asked in the sentence, with nothing to approve", () => {
    const copy = waitingCopy(waiting(withDetail("question", null)), Date.now());

    expect(copy?.code).toBeNull();
    expect(copy?.text).toBe("Spike asks: Run bun test");
  });

  test("a secret is named by the agent's label, with nothing to approve and no reason", () => {
    const secret = new ApprovalRequest({
      id: RequestId.make("r1"),
      sessionId: SessionId.make("s1"),
      turnId: TurnId.make("s1-t1"),
      kind: "secret",
      title: "Tailscale auth key",
      detail: "Make one under Settings → Keys",
      options: [],
      openedAt: "2026-10-28T20:00:00.000Z",
    });

    const copy = waitingCopy(waiting(secret), Date.now());

    expect(copy?.code).toBeNull();
    expect(copy?.kicker[1]).toBe("secret");
    expect(copy?.text).toBe("Spike is asking for a secret: Tailscale auth key");
  });
});

describe("a Data Source Approval reads one way everywhere (F13)", () => {
  const data = new ApprovalRequest(fixtureDataApproval(SessionId.make("s1"), TurnId.make("s1-t1")));

  test("the popover: the session wants to read the source", () => {
    expect(waitingCopy(waiting(data), Date.now())?.text).toBe("Spike wants to read analytics");
  });

  test("the notification's body says the same", () => {
    const summary = toSummary({
      inbox: { waiting: [waiting(data)], also: [], answered: [], count: 1 },
      focused: null,
    });

    expect(summary.sessions[0]?.requests[0]?.title).toBe("Spike wants to read analytics");
  });
});
