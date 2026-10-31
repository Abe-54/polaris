/** Read grants and write authority remain separate through the production Query service. */
import { expect, test } from "bun:test";
import { ApprovalDecision, DataSource } from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Stream } from "effect";
import { DataQueries, DataSources } from "./index.ts";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { parseConnection } from "./connection.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";

const source = (locality: "local" | "remote") =>
  new DataSource({
    id: "app",
    name: "app",
    engine: "postgres",
    host: "localhost",
    port: 5432,
    database: "app",
    user: "u",
    locality,
    foundIn: { kind: "manual" },
    access: "read",
    writes: "ask",
    label: { text: "", colour: "none" },
  });

const url = Redacted.make("postgres://u:password@localhost:5432/app");

const connection = parseConnection({ name: "app", url, foundIn: { kind: "manual" } })!.connection;

const remote = source("remote");

const unexpected = () => Effect.die("Unexpected source mutation");

const sources = Layer.succeed(
  DataSources,
  DataSources.of({
    list: () => Effect.succeed([remote]),
    refresh: () => Effect.succeed([remote]),
    watch: () => Stream.empty,
    resolve: () => Effect.succeed({ source: remote, connection, matchUrl: url }),
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

test("Local defaults and a one-request read grant cannot authorize a Remote write", () =>
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
          sql: "UPDATE items SET v=1",
          reason: "Repair",
        };

        yield* approvals.change(source("local"), "ask");
        expect(yield* Effect.flip(queries.execute(input))).toMatchObject({
          code: "E-DATA-DENIED",
          message: "Writes aren't allowed on this remote data source.",
        });
        const required = yield* Effect.flip(approvals.require(input.sessionId, remote));

        if (!Predicate.isTagged(required, "DataApprovalRequired"))
          throw new Error(required.message);
        yield* events.commit({
          commandId: null,
          decide: (model) =>
            Effect.succeed(
              decideSession(model.sessions.get(input.sessionId), {
                type: "approval.respond",
                requestId: required.approvalId,
                decision: ApprovalDecision.cases.Allow.make({ remember: false }),
                resolvedBy: "test",
              }).events
            ),
        });
        expect(
          yield* Effect.flip(queries.execute({ ...input, approvalId: required.approvalId }))
        ).toMatchObject({
          code: "E-DATA-DENIED",
          message: "Writes aren't allowed on this remote data source.",
        });
        yield* approvals.require(
          input.sessionId,
          remote,
          started.turns[0]!.id,
          required.approvalId
        );
        expect((yield* queries.pageLog({ sessionId: input.sessionId })).entries).toEqual([]);
        expect((yield* events.model).sessions.get(input.sessionId)!.pending.size).toBe(0);
      })
    ).pipe(Effect.provide(services))
  ));
