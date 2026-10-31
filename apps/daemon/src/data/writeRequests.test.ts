/** Durable receipts are read through DataQueries without reopening the database target. */
import { expect, test } from "bun:test";
import { ApprovalDecision, DataSourceApproval, DataWriteResult } from "@polaris/protocol";
import { Effect, Layer, Stream } from "effect";
import { DataQueries, DataSources } from "./index.ts";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { DataDatabase } from "./database.ts";
import { WriteApprovalStore } from "./writeApprovalStore.ts";
import { writeRequestHash, writeRequestKey } from "./writeIdentity.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";

const unexpected = () => Effect.die("Receipt retrieval must not reopen a data source");

const sources = Layer.succeed(
  DataSources,
  DataSources.of({
    list: unexpected,
    refresh: unexpected,
    resolve: unexpected,
    watch: () => Stream.empty,
    save: unexpected,
    remove: unexpected,
    label: unexpected,
    access: unexpected,
  })
);

const services = DataQueries.layer.pipe(
  Layer.provideMerge(Layer.merge(sources, QueryLog.layer)),
  Layer.provideMerge(approvalLayer())
);

test("requestId receipts survive projection reopen and Turn end; changed arguments cannot reuse a key", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* seedDataSession;
        const approvals = yield* DataApprovals;
        const queries = yield* DataQueries;
        const events = yield* EventStore;

        const input = {
          sessionId: started.session.id,
          tool: "execute" as const,
          source: "app",
          sql: "UPDATE items SET v=v+1",
          reason: "Increment once",
          requestId: "retry-key",
        };

        const fingerprint = writeRequestKey(input)!;

        const id = yield* approvals.writes.open(input.sessionId, started.turns[0]!.id, {
          target: new DataSourceApproval({
            sourceId: "s",
            sourceName: "app",
            engine: "postgres",
            host: "localhost",
            port: 5432,
            database: "app",
            user: "u",
          }),
          fingerprint,
          requestHash: writeRequestHash(input),
          queryId: "saved-write",
          sql: input.sql,
          reason: input.reason,
          affected: 1,
          columns: [],
          before: [],
          after: [],
          note: "Fixture records a completed transaction",
        });

        yield* events.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(
              decideSession(model.sessions.get(input.sessionId), {
                type: "approval.respond",
                requestId: id,
                decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                resolvedBy: "test",
              }).events
            ),
        });
        expect(yield* approvals.writes.claim(id)).toBe(true);
        const receipt = new DataWriteResult({ queryId: "saved-write", affected: 1, elapsedMs: 8 });
        yield* approvals.writes.finish(id, receipt);
        const reopened = new WriteApprovalStore((yield* DataDatabase).db);
        expect(reopened.find(fingerprint)?.result).toEqual(receipt);
        expect(reopened.claim(id)).toBe(false);
        yield* events.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(
              decideSession(model.sessions.get(input.sessionId), {
                type: "harness.turnEnded",
                turnId: started.turns[0]!.id,
                status: "completed",
                error: null,
                checkpoint: null,
                at: started.session.createdAt,
              }).events
            ),
        });
        expect(yield* queries.execute(input)).toEqual(receipt);
        expect(yield* queries.execute(input)).toEqual(receipt);
        expect(
          yield* Effect.flip(queries.execute({ ...input, sql: "DELETE FROM items" }))
        ).toMatchObject({
          code: "E-DATA-DENIED",
          message: "This requestId was already used with different write arguments.",
        });
        expect(
          yield* Effect.flip(queries.execute({ ...input, requestId: "another-key" }))
        ).toMatchObject({
          code: "E-DATA-DENIED",
          message: "The query's turn is no longer active.",
        });
      })
    ).pipe(Effect.provide(services))
  ));
