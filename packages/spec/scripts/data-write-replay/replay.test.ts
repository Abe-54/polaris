import { expect, test } from "bun:test";
import {
  ApprovalDecision,
  ApprovalRequest,
  DataSourceApproval,
} from "../../../protocol/src/domain.ts";
import { QueryLogEntry } from "../../../protocol/src/data.ts";
import { DomainEvent, EventEnvelope } from "../../../protocol/src/events.ts";
import { RequestId, SessionId, TurnId, Sequence } from "../../../protocol/src/ids.ts";
import { DataWriteTrace, replayDataWrite } from "./index.ts";

const at = "2026-10-30T00:00:00Z";

const request = new ApprovalRequest({
  id: RequestId.make("write"),
  sessionId: SessionId.make("s"),
  turnId: TurnId.make("t"),
  kind: "tool",
  title: "Run write",
  detail: null,
  options: [],
  questions: [],
  openedAt: at,
  dataWrite: {
    target: new DataSourceApproval({
      sourceId: "db",
      sourceName: "db",
      engine: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "u",
    }),
    fingerprint: "one",
    queryId: "q",
    sql: "UPDATE items SET v=1",
    reason: "Repair",
    affected: 1,
    identity: "original",
    previewed: true,
    columns: [],
    before: [],
    after: [],
    note: "Rolled back",
  },
});

const envelope = (event: typeof DomainEvent.Type) =>
  new EventEnvelope({ event, sequence: Sequence.make(1), occurredAt: at, commandId: null });

const opened = envelope(DomainEvent.cases.ApprovalRequested.make({ request }));

const allowed = envelope(
  DomainEvent.cases.ApprovalResolved.make({
    sessionId: request.sessionId,
    requestId: request.id,
    decision: ApprovalDecision.cases.Allow.make({ remember: false }),
    resolvedBy: "test",
  })
);

const log = (state: QueryLogEntry["state"]) =>
  new QueryLogEntry({
    id: "q",
    checkout: "/repo",
    source: { id: "db", name: "db" },
    sql: "UPDATE items SET v=1",
    state,
    author: { kind: "user" },
    at,
  });

const step = (
  status: (typeof DataWriteTrace.Type.steps)[number]["status"],
  value = 0
): (typeof DataWriteTrace.Type.steps)[number] => ({
  request,
  status,
  log: log(
    status === "pending" || status === "approved"
      ? "waiting-approval"
      : status === "denied"
        ? "failed"
        : status === "started"
          ? "running"
          : status
  ),
  events: status === "pending" ? [opened] : [opened, allowed],
  affected: 1,
  value,
  external: 0,
  identity: "original",
});

const trace: typeof DataWriteTrace.Type = {
  version: 2,
  source: "data-queries-write",
  steps: [step("pending"), step("approved"), step("completed", 1), step("completed", 1)],
};

test("F10: replay verifies actual approval events, projection, log and database observations", async () => {
  expect((await replayDataWrite(trace)).steps).toBe(4);

  for (const steps of [
    [step("pending"), step("completed", 1)],
    [step("pending"), { ...step("approved"), events: [opened] }, step("completed", 1)],
    [...trace.steps.slice(0, 3), step("completed", 2)],
    [step("pending"), step("approved"), { ...step("completed", 1), identity: "different" }],
    [step("pending"), step("approved"), { ...step("completed", 1), log: log("failed") }],
    [{ ...step("pending"), external: 1 }],
  ])
    await Promise.resolve(
      expect(replayDataWrite({ ...trace, steps })).rejects.toThrow("Data write replay rejected")
    );
  expect(
    (
      await replayDataWrite({
        ...trace,
        steps: [step("pending"), step("approved"), { ...step("failed"), identity: "different" }],
      })
    ).steps
  ).toBe(3);
  expect(
    (
      await replayDataWrite({
        ...trace,
        steps: [step("pending"), step("approved"), step("unknown", 1)],
      })
    ).steps
  ).toBe(3);
}, 60000);
