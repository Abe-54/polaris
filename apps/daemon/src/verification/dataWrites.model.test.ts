/** Random decisions, lifecycle endings and restarts drive the real machine and durable one-shot gate. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ApprovalDecision,
  ApprovalRequest,
  DataSourceApproval,
  EventEnvelope,
  RequestId,
  Sequence,
} from "@polaris/protocol";
import fc from "fast-check";
import { decideSession } from "../engine/session.ts";
import { started } from "../data/approvals.testing.ts";
import { ApprovalStore } from "../data/approvalStore.ts";
import { workingTurn } from "../store/model.ts";
import { pbtRuns, pbtSeed } from "./pbt.ts";

const request = new ApprovalRequest({
  id: RequestId.make("write"),
  sessionId: started.session.id,
  turnId: started.turns[0]!.id,
  kind: "tool",
  title: "Run write",
  detail: null,
  options: [],
  questions: [],
  openedAt: started.session.createdAt,
  dataWrite: {
    target: new DataSourceApproval({
      sourceId: "s",
      sourceName: "app",
      engine: "postgres",
      host: "localhost",
      port: 5432,
      database: "db",
      user: "u",
    }),
    fingerprint: "write",
    queryId: "q",
    sql: "UPDATE items SET v=1",
    reason: "Repair",
    affected: 2,
    columns: [],
    before: [],
    after: [],
    note: "Rows not shown",
  },
});

type Step = "request" | "allow" | "deny" | "claim" | "end" | "restart" | "wait";

interface Reference {
  phase: string;
  active: boolean;
  claims: number;
}

function reference(before: Reference, step: Step): Reference {
  switch (step) {
    case "request":
      return before.phase === "new" && before.active ? { ...before, phase: "pending" } : before;
    case "allow":
      return before.phase === "pending" ? { ...before, phase: "approved" } : before;
    case "deny":
      return before.phase === "pending" ? { ...before, phase: "denied" } : before;
    case "end":
      return {
        ...before,
        active: false,
        phase: before.phase === "pending" ? "denied" : before.phase,
      };
    case "claim":
      return before.active && before.phase === "approved"
        ? { ...before, phase: "started", claims: before.claims + 1 }
        : before;
    default:
      return before;
  }
}

class Actual {
  readonly db = new Database(":memory:");
  repo = new ApprovalStore(this.db);
  record = started;
  sequence = 0;
  decide(input: Parameters<typeof decideSession>[1]) {
    const decision = decideSession(this.record, input);
    this.record = decision.next.context.record!;

    const envelopes = decision.events.map(
      (event) =>
        new EventEnvelope({
          event,
          sequence: Sequence.make(++this.sequence),
          occurredAt: started.session.createdAt,
          commandId: null,
        })
    );

    this.repo.apply(envelopes, this.sequence);
  }
  step(step: Step) {
    switch (step) {
      case "request": {
        const existing = this.repo.writes.find("write");

        if (!existing || existing.status === "pending")
          this.decide({ type: "data.approvalRequested", request });
        break;
      }

      case "allow":
      case "deny":
        this.decide({
          type: "approval.respond",
          requestId: request.id,
          decision:
            step === "allow"
              ? ApprovalDecision.cases.Allow.make({ remember: false })
              : ApprovalDecision.cases.Deny.make({ reason: "No" }),
          resolvedBy: "test",
        });
        break;
      case "end":
        this.decide({
          type: "harness.turnEnded",
          turnId: request.turnId,
          status: "completed",
          error: null,
          checkpoint: null,
          at: started.session.createdAt,
        });
        break;
      case "restart":
        this.repo = new ApprovalStore(this.db);
        break;
      case "claim":
        return workingTurn(this.record) !== undefined && this.repo.writes.claim(request.id);
      case "wait":
        break;
    }

    return false;
  }
}

test("write decisions, retries and withdrawal agree with an independent one-shot model", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom<Step>("request", "allow", "deny", "claim", "end", "restart", "wait"),
        { minLength: 1, maxLength: 60 }
      ),
      (steps) => {
        const actual = new Actual();
        let expected: Reference = { phase: "new", active: true, claims: 0 };

        try {
          for (const step of steps) {
            const next = reference(expected, step);
            const claimed = actual.step(step);
            expect(claimed).toBe(next.claims > expected.claims);
            expected = next;
            expect(actual.repo.writes.find("write")?.status ?? "new").toBe(expected.phase);
            expect(actual.record.pending.size).toBe(expected.phase === "pending" ? 1 : 0);
            expect(expected.claims).toBeLessThanOrEqual(1);
          }
        } finally {
          actual.db.close();
        }
      }
    ),
    { numRuns: pbtRuns(200), ...pbtSeed() }
  );
});
