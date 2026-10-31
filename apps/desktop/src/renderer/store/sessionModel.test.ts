import { describe, expect, test } from "bun:test";
import {
  ApprovalDecision,
  ApprovalRequest,
  Compaction,
  ContextUsage,
  type DomainEvent,
  DomainEvent as Events,
  SessionStreamItem,
  TurnDetail,
  TurnItem,
} from "@polaris/protocol";
import {
  applySessionItems,
  emptySessionModel,
  type SecretOutcome,
  type WriteOutcome,
} from "./sessionModel.ts";
import {
  approval,
  envelope,
  seq,
  session,
  sessionId,
  turn,
  turnId,
  turnWith,
} from "./fixtures.testing.ts";

const S = SessionStreamItem.cases;

const E = Events.cases;

const event = (sequence: number, e: DomainEvent) =>
  S.Event.make({ envelope: envelope(sequence, e) });

const message = TurnItem.cases.AssistantMessage.make({ id: "m1", text: "one two three" });

const started = applySessionItems(
  emptySessionModel,
  structuredClone([
    S.Snapshot.make({ sequence: seq(2), session, turns: [], pendingApprovals: [] }),
    S.Synchronized.make({ sequence: seq(2) }),
    event(3, E.TurnStarted.make({ turn })),
  ])
);

describe("session model", () => {
  test("a Snapshot carries the session and its Turns", () => {
    const model = applySessionItems(emptySessionModel, [
      S.Snapshot.make({
        sequence: seq(9),
        session,
        turns: [new TurnDetail({ turn, items: [message], subagents: [] })],
        pendingApprovals: [approval],
      }),
    ]);

    expect(model.session?.title).toBe("Proof session");
    expect(model.turns[0]?.items).toEqual([message]);
    expect(model.pendingApprovals).toEqual([approval]);
  });

  test("a compaction folds into the session, for the context card", () => {
    const compaction = new Compaction({
      turnId,
      trigger: "auto",
      beforeTokens: 180_000,
      afterTokens: 20_000,
      at: "2026-10-11T10:00:00.000Z",
    });

    const model = applySessionItems(started, [
      event(4, E.SessionCompacted.make({ sessionId, compaction })),
    ]);

    expect(model.session?.lastCompaction).toEqual(compaction);
  });

  test("context usage folds into the session the header reads", () => {
    const usage = new ContextUsage({ usedTokens: 84_000, windowTokens: 200_000 });

    const model = applySessionItems(started, [
      event(4, E.SessionContextUsed.make({ sessionId, usage })),
    ]);

    expect(started.session?.contextUsage).toBeNull();
    expect(model.session?.contextUsage).toEqual(usage);
  });

  test("a live reasoning item keeps its start while its text streams", () => {
    const thinking = TurnItem.cases.Reasoning.make({
      id: "r1",
      text: "",
      startedAt: "2026-09-30T10:00:00.000Z",
      endedAt: null,
    });

    const model = applySessionItems(started, [
      S.ItemProgress.make({ turnId, item: thinking, subagentId: null }),
      S.Delta.make({ turnId, itemId: "r1", field: "text", text: "Hmm", subagentId: null }),
    ]);

    expect(model.turns[0]?.live.get("r1")).toMatchObject({ item: thinking, text: "Hmm" });
  });

  test("deltas stream into the live item until it completes", () => {
    const streaming = applySessionItems(started, [
      S.Delta.make({ turnId, itemId: "m1", field: "text", text: "one ", subagentId: null }),
      S.Delta.make({ turnId, itemId: "m1", field: "text", text: "two", subagentId: null }),
    ]);

    expect(streaming.turns[0]?.live.get("m1")?.text).toBe("one two");

    const done = applySessionItems(streaming, [
      event(4, E.TurnItemCompleted.make({ sessionId, turnId, item: message, subagentId: null })),
      S.Delta.make({ turnId, itemId: "m1", field: "text", text: " late", subagentId: null }),
    ]);

    expect(done.turns[0]?.items).toEqual([message]);
    expect(done.turns[0]?.live.size).toBe(0);
  });

  test("ItemProgress replaces an item's progress; TurnEnded clears what is left", () => {
    const running = TurnItem.cases.CommandExecution.make({
      id: "c1",
      command: "bun test",
      cwd: "/tmp",
      output: "",
      exitCode: null,
      status: "running",
    });

    const progressed = applySessionItems(started, [
      S.ItemProgress.make({ turnId, item: running, subagentId: null }),
      S.Delta.make({ turnId, itemId: "c1", field: "output", text: "ok\n", subagentId: null }),
    ]);

    const live = progressed.turns[0]?.live.get("c1");

    expect(live?.item).toEqual(running);
    expect(live?.output).toBe("ok\n");

    const ended = turnWith({ status: "completed", endedAt: turn.startedAt });
    const finished = applySessionItems(progressed, [event(4, E.TurnEnded.make({ turn: ended }))]);

    expect(finished.turns[0]?.turn.status).toBe("completed");
    expect(finished.turns[0]?.live.size).toBe(0);
  });

  test("state changes and approvals patch the session", () => {
    const model = applySessionItems(started, [
      event(4, E.SessionStateChanged.make({ sessionId, state: "needs-you", reason: null })),
      event(5, E.ApprovalRequested.make({ request: approval })),
    ]);

    expect(model.session?.state).toBe("needs-you");
    expect(model.session?.turnCount).toBe(1);
    expect(model.pendingApprovals).toHaveLength(1);

    const answered = applySessionItems(model, [
      event(
        6,
        E.ApprovalResolved.make({
          sessionId,
          requestId: approval.id,
          decision: ApprovalDecision.cases.Allow.make({ remember: false }),
          resolvedBy: "MacBook Pro",
        })
      ),
    ]);

    expect(answered.pendingApprovals).toEqual([]);
  });

  const secret = new ApprovalRequest({
    id: approval.id,
    sessionId,
    turnId,
    kind: "secret",
    title: "Tailscale auth key",
    detail: null,
    options: [],
    openedAt: approval.openedAt,
  });

  const resolved = (decision: ApprovalDecision) =>
    E.ApprovalResolved.make({
      sessionId,
      requestId: secret.id,
      decision,
      resolvedBy: "Mac Studio",
    });

  const D = ApprovalDecision.cases;

  test.each<readonly [string, DomainEvent, SecretOutcome]>([
    ["saved", resolved(D.Provided.make({})), "provided"],
    ["declined", resolved(D.Deny.make({ reason: null })), "declined"],
    [
      "timed out",
      E.ApprovalWithdrawn.make({
        sessionId,
        requestId: secret.id,
        withdrawnBy: "daemon",
        reason: "timed out",
      }),
      "ended",
    ],
  ])("a %s Secret Request leaves pending but keeps its card, settled", (_name, ended, outcome) => {
    const asked = applySessionItems(started, [
      event(4, E.ApprovalRequested.make({ request: secret })),
    ]);

    const model = applySessionItems(asked, [event(5, ended)]);

    expect(model.pendingApprovals).toEqual([]);
    expect(model.settledSecrets).toEqual([{ request: secret, outcome }]);
  });

  const write = new ApprovalRequest({
    id: approval.id,
    sessionId,
    turnId,
    kind: "tool",
    title: "Run 214-row write",
    detail: null,
    options: [],
    openedAt: approval.openedAt,
    dataWrite: {
      target: {
        sourceId: "src-app",
        sourceName: "app",
        engine: "postgres",
        host: "localhost",
        port: 5432,
        database: "ledger",
        user: "ledger",
      },
      fingerprint: "fp",
      queryId: "q1",
      sql: "update invoices set currency = 'USD'",
      reason: "backfill",
      affected: 214,
      columns: [],
      before: [],
      after: [],
      note: "",
    },
  });

  const answeredBy = (decision: ApprovalDecision, resolvedBy: string) =>
    E.ApprovalResolved.make({ sessionId, requestId: write.id, decision, resolvedBy });

  test.each<readonly [string, DomainEvent, WriteOutcome]>([
    ["allowed", answeredBy(D.Allow.make({ remember: false }), "Mac Studio"), { kind: "allowed" }],
    [
      "denied with a reason",
      answeredBy(D.Deny.make({ reason: "use EUR" }), "Mac Studio"),
      { kind: "denied", reason: "use EUR" },
    ],
    [
      "withdrawn when the Turn ended",
      E.ApprovalWithdrawn.make({
        sessionId,
        requestId: write.id,
        withdrawnBy: "harness",
        reason: "turn ended",
      }),
      { kind: "expired", by: "harness" },
    ],
    [
      "withdrawn, as an older log records it",
      answeredBy(D.Deny.make({ reason: null }), "Daemon"),
      { kind: "expired", by: "daemon" },
    ],
  ])("a write %s leaves pending but keeps its card, settled", (_name, ended, outcome) => {
    const asked = applySessionItems(started, [
      event(4, E.ApprovalRequested.make({ request: write })),
    ]);

    const model = applySessionItems(asked, [event(5, ended)]);

    expect(model.pendingApprovals).toEqual([]);
    expect(model.settledWrites).toEqual([{ request: write, outcome }]);
  });

  test("an ordinary approval settles into nothing", () => {
    const asked = applySessionItems(started, [
      event(4, E.ApprovalRequested.make({ request: approval })),
    ]);

    const model = applySessionItems(asked, [
      event(
        5,
        E.ApprovalResolved.make({
          sessionId,
          requestId: approval.id,
          decision: D.Deny.make({ reason: null }),
          resolvedBy: "Mac Studio",
        })
      ),
    ]);

    expect(model.settledSecrets ?? []).toEqual([]);
  });
});
