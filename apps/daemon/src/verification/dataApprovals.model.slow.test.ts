/** Independent target-policy model drives the real Session decider and SQLite approval projection. */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  AgentSession,
  SessionId,
  Turn,
  TurnId,
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
import { workingTurn } from "../store/model.ts";
import { pbtRuns, pbtSeed, pbtTimeout } from "./pbt.ts";

const source = (index: number, local = false) =>
  new DataSource({
    id: `source-${index}`,
    name: `source-${index}`,
    engine: "postgres",
    host: index === 2 ? "server2" : "server1",
    port: 5432,
    database: index === 1 ? "db2" : "db1",
    user: index === 3 ? "admin" : "reader",
    locality: local ? "local" : "remote",
    foundIn: { kind: "manual" },
    access: "needs-approval",
    writes: "off",
    label: { text: "", colour: "none" },
    reachable: true,
  });

const at = started.session.createdAt;

const RUNS = pbtRuns(100);

test(
  "approval target, server, denial and revocation sequences agree with an independent model",
  () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            target: fc.integer({ min: 0, max: 3 }),
            session: fc.integer({ min: 0, max: 1 }),
            action: fc.constantFrom(
              "allow",
              "server",
              "once",
              "deny",
              "revoke",
              "restart",
              "local",
              "remote",
              "writes",
              "writes-ask",
              "end"
            ),
          }),
          { minLength: 1, maxLength: 50 }
        ),
        (steps) => {
          const db = new Database(":memory:");
          let repository = new ApprovalStore(db);

          const records = [
            started,
            {
              ...started,
              session: new AgentSession({
                ...Schema.decodeUnknownSync(Schema.Struct(AgentSession.fields))(started.session),
                id: SessionId.make("model-session-2"),
              }),
              turns: [
                new Turn({
                  ...Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(started.turns[0]!),
                  id: TurnId.make("model-turn-2"),
                  sessionId: SessionId.make("model-session-2"),
                }),
              ],
            },
          ];

          let sequence = 0;
          const exact = new Map<number, "approved" | "denied">();
          const local = new Set<number>();
          const writes = new Map<number, { local: boolean; policy: "ask" | "off" }>();
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
              const target = source(step.target, local.has(step.target));
              const key = `${target.host}/${target.user}`;

              const handled = applyPolicy(
                step.action,
                step.target,
                target,
                key,
                repository,
                exact,
                servers,
                local,
                writes
              );

              if (step.action === "restart") repository = new ApprovalStore(db);
              else if (!handled) {
                records[step.session] = decideApproval(
                  records[step.session]!,
                  sequence,
                  target,
                  step.action,
                  apply,
                  repository
                );
                updateModelDecision(step.action, step.target, key, exact, servers);
              }

              checkPolicy(repository, exact, servers, local, writes);
            }
          } finally {
            db.close();
          }
        }
      ),
      { numRuns: RUNS, ...pbtSeed() }
    );
  },
  pbtTimeout(RUNS, 100)
);

function decideApproval(
  record: typeof started,
  sequence: number,
  target: DataSource,
  action: string,
  apply: (events: ReadonlyArray<DomainEvent>) => void,
  repository: ApprovalStore
) {
  const id = RequestId.make(`data-source-${sequence}`);
  const turn = workingTurn(record)!;

  const request = new ApprovalRequest({
    id,
    sessionId: record.session.id,
    turnId: turn.id,
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

  repository.join(id, record.session.id, turn.id);

  if (action === "end") {
    const ended = decideSession(record, {
      type: "harness.turnEnded",
      turnId: turn.id,
      status: "completed",
      error: null,
      checkpoint: null,
      at,
    });

    apply(ended.events);
    expect(repository.outcome(id)?.status).toBe("denied");
    expect(ended.next.context.record!.pending.size).toBe(0);

    const next = new Turn({
      ...Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(turn),
      id: TurnId.make(`model-turn-${sequence}`),
      index: record.turns.length + 1,
    });

    const continued = decideSession(ended.next.context.record!, { type: "turn.send", turn: next });
    apply(continued.events);
    expect(workingTurn(continued.next.context.record!)?.id).toBe(next.id);

    return continued.next.context.record!;
  }

  const decision =
    action === "deny"
      ? ApprovalDecision.cases.Deny.make({ reason: "No" })
      : ApprovalDecision.cases.Allow.make({
          remember: action !== "once",
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

  if (action === "once") {
    expect(repository.consume(id, record.session.id, turn.id, target)).toBe(true);
    expect(repository.consume(id, record.session.id, turn.id, target)).toBe(false);
  }

  return record;
}

function checkPolicy(
  repository: ApprovalStore,
  exact: Map<number, "approved" | "denied">,
  servers: Set<string>,
  local: Set<number>,
  writes: Map<number, { local: boolean; policy: "ask" | "off" }>
) {
  for (let target = 0; target < 4; target++) {
    const expected =
      exact.get(target) ??
      (servers.has(`${source(target).host}/${source(target).user}`)
        ? "approved"
        : local.has(target)
          ? "read"
          : "needs-approval");

    expect(repository.read(source(target, local.has(target)))).toEqual({
      access: expected,
      writes:
        writes.get(target)?.local === local.has(target)
          ? writes.get(target)!.policy
          : local.has(target)
            ? "ask"
            : "off",
    });
  }
}

function updateModelDecision(
  action: string,
  target: number,
  key: string,
  exact: Map<number, "approved" | "denied">,
  servers: Set<string>
) {
  if (action === "server") servers.add(key);
  else if (action === "allow" || action === "deny") {
    exact.set(target, action === "deny" ? "denied" : "approved");
  }
}

function applyPolicy(
  action: string,
  index: number,
  target: DataSource,
  key: string,
  repository: ApprovalStore,
  exact: Map<number, "approved" | "denied">,
  servers: Set<string>,
  local: Set<number>,
  writes: Map<number, { local: boolean; policy: "ask" | "off" }>
) {
  switch (action) {
    case "revoke":
      repository.change(target, undefined, true);
      exact.delete(index);
      servers.delete(key);
      writes.delete(index);

      return true;
    case "local":
      local.add(index);

      return true;
    case "remote":
      local.delete(index);

      return true;
    case "writes":
    case "writes-ask":
      repository.change(target, action === "writes" ? "off" : "ask");
      writes.set(index, { local: local.has(index), policy: action === "writes" ? "off" : "ask" });

      return true;
    default:
      return false;
  }
}
