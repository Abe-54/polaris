/** Runs in a child with an isolated POLARIS_HOME; imports the production service composition. */
import assert from "node:assert/strict";
import { ApprovalDecision, DataRpcs } from "@polaris/protocol";
import { Effect, Layer, Predicate } from "effect";
import { RpcTest } from "effect/rpc";
import { useFileSecretsForTests } from "../secrets/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";
import { dataServices } from "../transport/serve.ts";
import { DataQueries, DataRpcsLive } from "./index.ts";
import { seedDataSessionAt, started } from "./approvals.testing.ts";

import { paths } from "../paths.ts";

useFileSecretsForTests();

const services = DataRpcsLive.pipe(
  Layer.provideMerge(dataServices),
  Layer.provideMerge(EventStore.layerSqlite(":memory:"))
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* seedDataSessionAt(paths().root);
      const client = yield* RpcTest.makeClient(DataRpcs);
      const queries = yield* DataQueries;
      const store = yield* EventStore;
      const sessionId = started.session.id;

      const saved = yield* client["data.source.save"]({
        sessionId,
        name: "remote",
        engine: "postgres",
        host: "db.example",
        port: 5432,
        database: "app",
        user: "reader",
        label: { text: "", colour: "none" },
      });

      const pending = yield* Effect.flip(
        queries.query({
          sessionId,
          source: saved.id,
          sql: "SELECT $1",
          params: ["private-param"],
          tool: "query",
        })
      );

      assert(Predicate.isTagged(pending, "DataApprovalRequired"));
      const log = yield* client["data.queryLog.page"]({ sessionId });
      assert.equal(log.entries.length, 1);
      assert.equal(log.entries[0]!.state, "waiting-approval");
      assert.equal(log.entries[0]!.params, undefined);
      assert.equal(log.entries[0]!.author.kind, "agent");
      assert.equal((yield* store.model).sessions.get(sessionId)!.session.state, "needs-you");
      yield* store.commit({
        commandId: null,
        decide: (model) =>
          Effect.succeed(
            decideSession(model.sessions.get(sessionId), {
              type: "approval.respond",
              requestId: pending.approvalId,
              decision: ApprovalDecision.cases.Deny.make({ reason: "Use staging" }),
              resolvedBy: "test",
            }).events
          ),
      });
      assert.deepEqual(yield* queries.awaitApproval(pending.approvalId, 100), {
        status: "denied",
        reason: "Use staging",
      });

      const denied = yield* Effect.flip(
        queries.describe({ sessionId, source: saved.id, tool: "describe" })
      );

      assert(Predicate.isTagged(denied, "DataError"));
      assert.equal(denied.code, "E-DATA-DENIED");

      const outside = {
        sessionId,
        turn: started.turns[0]!.id,
        source: saved.id,
        command: "psql --version",
        itemId: "outside-1",
      };

      yield* queries.recordOutside(outside);
      yield* queries.recordOutside(outside);
      const final = yield* client["data.queryLog.page"]({ sessionId });
      assert.equal(final.entries.filter((entry) => entry.author.kind === "outside").length, 1);
      assert.equal(final.entries.find((entry) => entry.approval)?.approval?.status, "denied");
    })
  ).pipe(Effect.provide(services))
);
