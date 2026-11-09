import { describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  DomainEvent,
  RequestId,
  Sequence,
  SessionStreamItem,
  Subagent,
  SubagentDetail,
  SubagentId,
  TurnDetail,
  TurnItem,
} from "@polaris/protocol";
import { at, event, request, session, sessionId, snapshot, turn } from "./daemon.testing.ts";
import { applySessionItem, latestSecretOutcome, type SessionFold } from "./fold.ts";

const helper = (id: string, status: Subagent["status"] = "working") =>
  new Subagent({
    id: SubagentId.make(id),
    sessionId,
    turnId: turn(0).id,
    parentItemId: null,
    title: `Helper ${id}`,
    agent: "Explore",
    model: null,
    status,
    startedAt: at,
    endedAt: status === "working" ? null : at,
  });

const fold = (...items: ReadonlyArray<SessionStreamItem>): SessionFold | null =>
  items.reduce<SessionFold | null>(applySessionItem, null);

describe("subagents", () => {
  test("a snapshot keeps every Turn's Subagents, in order", () => {
    const opened = SessionStreamItem.cases.Snapshot.make({
      sequence: Sequence.make(1),
      session: session({ turnCount: 2 }),
      turns: [0, 1].map(
        (index) =>
          new TurnDetail({
            turn: turn(index),
            items: [],
            subagents: [new SubagentDetail({ subagent: helper(`a${index}`), items: [] })],
          })
      ),
      pendingApprovals: [],
    });

    expect(fold(opened)?.subagents.map((s) => String(s.id))).toEqual(["a0", "a1"]);
  });

  test("a Subagent ending is updated in its place, not added again", () => {
    const state = fold(
      snapshot([{ turn: turn(0, { status: "working" }) }]),
      event(2, DomainEvent.cases.SubagentStarted.make({ subagent: helper("a") })),
      event(3, DomainEvent.cases.SubagentStarted.make({ subagent: helper("b") })),
      event(4, DomainEvent.cases.SubagentEnded.make({ subagent: helper("a", "completed") }))
    );

    expect(state?.subagents.map((s) => `${s.id} ${s.status}`)).toEqual([
      "a completed",
      "b working",
    ]);
  });
});

type ToolOutput = Extract<TurnItem, { readonly _tag: "ToolCall" }>["output"];

describe("a Secret Request's outcome", () => {
  const secret = request({ kind: "secret", title: "Tailscale auth key", detail: "To join" });
  const asked = snapshot([{ turn: turn(1, { status: "working" }) }], {}, [secret]);

  const resolved = (decision: ApprovalDecision) =>
    event(
      2,
      DomainEvent.cases.ApprovalResolved.make({
        sessionId,
        requestId: secret.id,
        decision,
        resolvedBy: "iPhone",
      })
    );

  const withdrawn = event(
    2,
    DomainEvent.cases.ApprovalWithdrawn.make({
      sessionId,
      requestId: secret.id,
      withdrawnBy: "daemon",
      reason: "timed out",
    })
  );

  test.each([
    ["provided", resolved(ApprovalDecision.cases.Provided.make({})), "saved"],
    ["declined", resolved(ApprovalDecision.cases.Deny.make({ reason: null })), "declined"],
    ["withdrawn", withdrawn, "ended"],
  ] as const)("%s reads %p while its Turn is the latest", (_, ending, outcome) => {
    const state = fold(asked, ending);

    expect(state?.pendingApprovals).toEqual([]);
    expect(state === null ? null : latestSecretOutcome(state)?.outcome).toBe(outcome);
  });

  test("goes once the next Turn starts, and a permission's answer never makes one", () => {
    const next = event(3, DomainEvent.cases.TurnStarted.make({ turn: turn(2) }));
    const later = fold(asked, withdrawn, next);
    expect(later === null ? "none" : latestSecretOutcome(later)).toBeNull();

    const permission = request({ id: RequestId.make("r-2") });

    const answered = fold(
      snapshot([{ turn: turn(1, { status: "working" }) }], {}, [permission]),
      event(
        2,
        DomainEvent.cases.ApprovalResolved.make({
          sessionId,
          requestId: permission.id,
          decision: ApprovalDecision.cases.Deny.make({ reason: null }),
          resolvedBy: "iPhone",
        })
      )
    );

    expect(answered?.secretOutcomes).toEqual([]);
  });

  const call = (output: ToolOutput, status: "running" | "completed" = "completed") =>
    TurnItem.cases.ToolCall.make({
      id: "c-1",
      name: "mcp__polaris__request_secret",
      input: { label: "Tailscale auth key", reason: "To join" },
      output,
      status,
    });

  test.each([
    ["Saved. The secret is in /tmp/s, readable by your commands for 24 hours.", "saved"],
    [[{ type: "text", text: "The user declined.\nCarry on without it." }], "declined"],
    [
      { content: [{ type: "text", text: "No answer in 10 minutes; the request was withdrawn." }] },
      "ended",
    ],
  ] as const)("after a reload, its call's reply %# still says how it ended", (output, outcome) => {
    const reloaded = fold(snapshot([{ turn: turn(1), items: [call(output)] }]));
    const shown = reloaded === null ? null : latestSecretOutcome(reloaded);

    expect([shown?.request.title, shown?.outcome]).toEqual(["Tailscale auth key", outcome]);
  });

  test("a call still waiting on the user says nothing yet", () => {
    const waiting = fold(snapshot([{ turn: turn(1), items: [call(null, "running")] }]));

    expect(waiting === null ? "none" : latestSecretOutcome(waiting)).toBeNull();
  });
});
