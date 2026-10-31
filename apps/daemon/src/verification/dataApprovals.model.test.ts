/** Independent target-policy model drives the real Session decider and SQLite approval projection. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ApprovalDecision,
  ApprovalRequest,
  DataSource,
  DomainEvent,
  EventEnvelope,
  RequestId,
  Sequence,
} from "@polaris/protocol";
import { Schema } from "effect";
import fc from "fast-check";
import { decideSession } from "../engine/session.ts";
import { started } from "../data/approvals.testing.ts";
import { ApprovalStore, targetOf } from "../data/approvalStore.ts";
import { pbtRuns, pbtSeed } from "./pbt.ts";

const source = (index: number) =>
  new DataSource({
    id: `source-${index}`,
    name: `source-${index}`,
    engine: "postgres",
    host: index === 2 ? "server2" : "server1",
    port: 5432,
    database: index === 1 ? "db2" : "db1",
    user: "reader",
    locality: "remote",
    foundIn: { kind: "manual" },
    access: "needs-approval",
    writes: "off",
    label: { text: "", colour: "none" },
    reachable: true,
  });

const at = started.session.createdAt;

test("approval target, server, denial and revocation sequences agree with an independent model", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          target: fc.integer({ min: 0, max: 2 }),
          action: fc.constantFrom("allow", "server", "deny", "revoke", "restart"),
        }),
        { minLength: 1, maxLength: 50 }
      ),
      (steps) => {
        const db = new Database(":memory:");
        let repository = new ApprovalStore(db);
        let record = started;
        let sequence = 0;
        const exact = new Map<number, "approved" | "denied" | "needs-approval">();
        const servers = new Set<string>();

        const apply = (events: ReadonlyArray<DomainEvent>) => {
          const envelopes = events.map(
            (event) =>
              new EventEnvelope({
                event,
                sequence: Sequence.make(++sequence),
                occurredAt: at,
                commandId: null,
              })
          );

          repository.apply(envelopes, sequence);
        };

        try {
          for (const step of steps) {
            const target = source(step.target);

            if (step.action === "revoke") {
              repository.change(target, undefined, true);
              exact.set(step.target, "needs-approval");
            } else if (step.action === "restart") {
              // Recreate the repository over the same SQLite contents; decisions must survive.
              repository = new ApprovalStore(db);
            } else {
              record = decideApproval(record, sequence, target, step.action, apply);

              if (step.action === "server") servers.add(target.host);
              exact.set(step.target, step.action === "deny" ? "denied" : "approved");
            }

            checkPolicy(repository, exact, servers);
          }
        } finally {
          db.close();
        }
      }
    ),
    { numRuns: pbtRuns(100), ...pbtSeed() }
  );
});

function decideApproval(
  record: typeof started,
  sequence: number,
  target: DataSource,
  action: string,
  apply: (events: ReadonlyArray<DomainEvent>) => void
) {
  const id = RequestId.make(`data-source-${sequence}`);

  const request = new ApprovalRequest({
    id,
    sessionId: record.session.id,
    turnId: record.turns[0]!.id,
    kind: "tool",
    dataSource: targetOf(target),
    title: "Read",
    detail: null,
    options: [],
    questions: [],
    openedAt: at,
  });

  const opened = decideSession(record, { type: "data.approvalRequested", request });
  apply(opened.events);
  record = opened.next.context.record!;

  const duplicate = decideSession(record, {
    type: "data.approvalRequested",
    request: new ApprovalRequest({
      ...Schema.decodeUnknownSync(Schema.Struct(ApprovalRequest.fields))(request),
      id: RequestId.make(`${id}-duplicate`),
    }),
  });

  expect(duplicate.events).toHaveLength(0);
  expect(record.session.state).toBe("needs-you");

  const decision =
    action === "deny"
      ? ApprovalDecision.cases.Deny.make({ reason: "No" })
      : ApprovalDecision.cases.Allow.make({
          remember: true,
          dataScope: action === "server" ? "server" : "target",
        });

  const closed = decideSession(record, {
    type: "approval.respond",
    requestId: id,
    decision,
    resolvedBy: "test",
  });

  apply(closed.events);
  record = closed.next.context.record!;
  expect(record.session.state).toBe("working");
  expect(record.pending.size).toBe(0);

  return record;
}

function checkPolicy(
  repository: ApprovalStore,
  exact: Map<number, "approved" | "denied" | "needs-approval">,
  servers: Set<string>
) {
  for (let target = 0; target < 3; target++) {
    const expected =
      exact.get(target) ?? (servers.has(source(target).host) ? "approved" : "needs-approval");

    expect(repository.read(source(target)).access).toBe(expected);
  }
}
