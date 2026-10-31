/** The real DataQueries service, Session machine, SQLite projection and disposable database. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { ApprovalDecision, DataSource, Unsupported } from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Stream } from "effect";
import { DataQueries, DataSources } from "./index.ts";
import { DataApprovals } from "./approvals.ts";
import { QueryLog } from "./queryLog.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { parseConnection } from "./connection.ts";
import { sqlOptions } from "./pools.ts";
import { EventStore } from "../store/EventStore.ts";
import {
  DataWriteTrace,
  replayDataWrite,
} from "../../../../packages/spec/scripts/data-write-replay/index.ts";
import { observeWrite } from "./writeTrace.testing.ts";
import { decideSession } from "../engine/session.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: dry-run/approve/retry/deny use the real write approval lifecycle`,
    async () => {
      const parsed = parseConnection({
        name: "test",
        url: Redacted.make(url!),
        foundIn: { kind: "manual" },
      })!;

      const { connection } = parsed;
      const name = `polaris_wa_${crypto.randomUUID().replaceAll("-", "")}`;

      const source = new DataSource({
        id: name,
        name,
        engine,
        host: connection.hostname,
        port: connection.port,
        database: connection.database,
        user: connection.username,
        locality: "local",
        foundIn: { kind: "manual" },
        access: "read",
        writes: "ask",
        label: { text: "", colour: "none" },
      });

      const admin = new SQL({
        ...sqlOptions(source, connection),
        allowPublicKeyRetrieval: engine === "mysql",
      });

      const unavailable = () => Effect.fail(new Unsupported({ capability: "test" }));

      const sources = Layer.succeed(
        DataSources,
        DataSources.of({
          list: () => Effect.succeed([source]),
          refresh: () => Effect.succeed([source]),
          resolve: () => Effect.succeed({ source, connection, matchUrl: Redacted.make(url!) }),
          watch: () => Stream.succeed([source]),
          save: unavailable,
          remove: unavailable,
          label: unavailable,
          access: unavailable,
        })
      );

      const layer = DataQueries.layer.pipe(
        Layer.provideMerge(Layer.merge(sources, QueryLog.layer)),
        Layer.provideMerge(approvalLayer())
      );

      const trace: typeof DataWriteTrace.Type = {
        version: 2,
        source: "data-queries-write",
        steps: [],
      };

      const steps: Array<(typeof DataWriteTrace.Type.steps)[number]> = [];

      try {
        await admin.unsafe(`CREATE TABLE ${name} (id INT PRIMARY KEY,v INT NOT NULL)`);
        await admin.unsafe(`INSERT INTO ${name} VALUES (1,0)`);

        const value = () =>
          Effect.promise(
            async () =>
              (await admin.unsafe<Array<{ v: number }>>(`SELECT v FROM ${name} WHERE id=1`))[0]!.v
          );

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              yield* seedDataSession;
              const queries = yield* DataQueries;
              const approvals = yield* DataApprovals;
              const store = yield* EventStore;

              const input = {
                sessionId: started.session.id,
                turn: started.turns[0]!.id,
                tool: "execute" as const,
                source: name,
                sql: `UPDATE ${name} SET v=v+1 WHERE id=1`,
                reason: "Increment once",
                requestId: "increment-once",
              };

              const required = yield* Effect.flip(queries.execute(input));

              if (!Predicate.isTagged(required, "DataApprovalRequired"))
                throw new Error(required.message);
              expect(yield* value()).toBe(0);
              steps.push(yield* observeWrite(input, { affected: 1, value: yield* value() }));
              const again = yield* Effect.flip(queries.execute(input));
              expect(again).toEqual(required);

              const answer = (
                decision: typeof ApprovalDecision.Type,
                requestId = required.approvalId
              ) =>
                store.commit({
                  commandId: null,
                  decide: (model) =>
                    Effect.succeed(
                      decideSession(model.sessions.get(started.session.id), {
                        type: "approval.respond",
                        requestId,
                        decision,
                        resolvedBy: "test",
                      }).events
                    ),
                });

              yield* answer(ApprovalDecision.cases.Allow.make({ remember: false }));
              expect(yield* approvals.awaitApproval(required.approvalId, 100)).toEqual({
                status: "approved",
              });
              steps.push(yield* observeWrite(input, { affected: 1, value: yield* value() }));
              const first = yield* queries.execute(input);
              steps.push(
                yield* observeWrite(input, { affected: first.affected, value: yield* value() })
              );

              const [retry, retry2] = yield* Effect.all(
                [queries.execute(input), queries.execute(input)],
                { concurrency: "unbounded" }
              );

              expect(retry2).toEqual(first);
              steps.push(
                yield* observeWrite(input, { affected: retry.affected, value: yield* value() })
              );
              expect(first).toEqual(retry);
              expect(
                yield* Effect.flip(queries.execute({ ...input, reason: "Changed intent" }))
              ).toMatchObject({
                code: "E-DATA-DENIED",
                message: "This requestId was already used with different write arguments.",
              });
              expect(first.affected).toBe(1);
              expect(yield* value()).toBe(1);
              const deniedInput = { ...input, requestId: "denied-write" };
              const denied = yield* Effect.flip(queries.execute(deniedInput));

              if (!Predicate.isTagged(denied, "DataApprovalRequired"))
                throw new Error(denied.message);
              yield* answer(
                ApprovalDecision.cases.Deny.make({ reason: "Use staging" }),
                denied.approvalId
              );
              expect(yield* Effect.flip(queries.execute(deniedInput))).toMatchObject({
                code: "E-DATA-DENIED",
                message: "Use staging",
              });
              expect(yield* value()).toBe(1);
              const page = yield* queries.pageLog({ sessionId: started.session.id });
              const completed = page.entries.filter((entry) => entry.state === "completed");
              expect(completed).toHaveLength(1);
              expect(completed[0]).toMatchObject({
                author: { kind: "agent" },
                rows: 1,
                affected: [{ table: name, rows: 1 }],
              });
              expect(page.entries.filter((entry) => entry.state === "dry-run")).toHaveLength(2);
              yield* store.commit({
                commandId: null,
                decide: (model) =>
                  Effect.succeed(
                    decideSession(model.sessions.get(started.session.id), {
                      type: "harness.turnEnded",
                      turnId: input.turn,
                      status: "completed",
                      error: null,
                      checkpoint: null,
                      at: started.session.createdAt,
                    }).events
                  ),
              });
              expect(yield* queries.execute(input)).toEqual(first);
              expect(yield* value()).toBe(1);
            })
          ).pipe(Effect.provide(layer))
        );
        const recorded = { ...trace, steps };
        expect((await replayDataWrite(recorded)).steps).toBe(4);

        if (process.env.POLARIS_DATA_WRITE_TRACE_DIR)
          await Bun.write(
            `${process.env.POLARIS_DATA_WRITE_TRACE_DIR}/${engine}.json`,
            JSON.stringify(recorded)
          );
      } finally {
        await admin.unsafe(`DROP TABLE IF EXISTS ${name}`);
        await admin.close();
      }
    },
    30000
  );
}
