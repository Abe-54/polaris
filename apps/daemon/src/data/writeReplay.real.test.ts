/** Record denied, identity-drift, unknown and trigger paths from the real service and event store. */
import { expect, test } from "bun:test";
import { ApprovalDecision, Unsupported } from "@polaris/protocol";
import { Effect, Layer, Predicate, Redacted, Stream, Match } from "effect";
import { DataQueries, DataSources } from "./index.ts";
import { QueryLog } from "./queryLog.ts";
import { approvalLayer, seedDataSession, started } from "./approvals.testing.ts";
import { EventStore } from "../store/EventStore.ts";
import { decideSession } from "../engine/session.ts";
import { databaseUrl, writeFixture } from "./writeFixes.testing.ts";
import { identityHash } from "./writeRows.ts";
import type { RawResult } from "./values.ts";
import { observeWrite, saveWriteTrace } from "./writeTrace.testing.ts";
import {
  DataWriteTrace,
  replayDataWrite,
} from "../../../../packages/spec/scripts/data-write-replay/index.ts";

for (const engine of ["postgres", "mysql"] as const)
  for (const path of ["drift", "denied", "not-previewed", "unknown"] as const) {
    test.skipIf(!databaseUrl(engine) || (engine === "mysql" && path === "unknown"))(
      `${engine} F10: recorded ${path} path replays persisted evidence`,
      async () => {
        const f = writeFixture(engine);
        const { admin, name: t, source, connection, url } = f;
        const unavailable = () => Effect.fail(new Unsupported({ capability: "test" }));

        const sources = Layer.succeed(
          DataSources,
          DataSources.of({
            list: () => Effect.succeed([source]),
            refresh: () => Effect.succeed([source]),
            resolve: () => Effect.succeed({ source, connection, matchUrl: Redacted.make(url) }),
            watch: () => Stream.empty,
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

        const steps: Array<(typeof DataWriteTrace.Type.steps)[number]> = [];

        const read = () =>
          Effect.promise(async () =>
            Number((await admin.unsafe<Array<{ v: number }>>(`SELECT SUM(v) AS v FROM ${t}`))[0]!.v)
          );

        try {
          await admin.unsafe(
            `CREATE TABLE ${t}(id int PRIMARY KEY,v int,api_token varchar(64) DEFAULT 'wf_row_secret')`
          );
          await admin.unsafe(`INSERT INTO ${t}(id,v) VALUES(1,0),(2,0)`);

          if (path === "not-previewed" || path === "unknown") {
            if (engine === "postgres") {
              await admin.unsafe(
                `CREATE FUNCTION ${t}_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${path === "unknown" ? "PERFORM pg_terminate_backend(pg_backend_pid());" : ""} RETURN NEW; END $$`
              );
              await admin.unsafe(
                `CREATE CONSTRAINT TRIGGER ${t}_tr AFTER UPDATE ON ${t} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${t}_trg()`
              );
            } else
              await admin.unsafe(
                `CREATE TRIGGER ${t}_tr BEFORE UPDATE ON ${t} FOR EACH ROW SET NEW.v=NEW.v`
              );
          }

          await Effect.runPromise(
            Effect.scoped(
              Effect.gen(function* () {
                yield* seedDataSession;
                const queries = yield* DataQueries;
                const store = yield* EventStore;

                const input = {
                  sessionId: started.session.id,
                  tool: "execute" as const,
                  source: source.id,
                  sql: `UPDATE ${t} SET v=${engine === "postgres" ? "$1" : "?"} WHERE v=0`,
                  params: [1],
                  reason: "Test write",
                  requestId: path,
                };

                const pending = yield* Effect.flip(queries.execute(input));

                if (!Predicate.isTagged(pending, "DataApprovalRequired")) throw pending;
                steps.push(yield* observeWrite(input, { affected: 2, value: yield* read() }));
                expect(steps[0]!.request.dataWrite?.params).toEqual([1]);
                expect(JSON.stringify(steps[0]!.request)).not.toContain("wf_row_secret");
                expect(JSON.stringify(steps[0]!.events)).not.toContain("wf_row_secret");
                expect(steps[0]!.request.dataWrite?.previewed).toBe(
                  path !== "not-previewed" && path !== "unknown"
                );
                yield* store.commit({
                  commandId: null,
                  decide: (model) =>
                    Effect.succeed(
                      decideSession(model.sessions.get(input.sessionId), {
                        type: "approval.respond",
                        requestId: pending.approvalId,
                        decision:
                          path === "denied"
                            ? ApprovalDecision.cases.Deny.make({ reason: null })
                            : ApprovalDecision.cases.Allow.make({ remember: false }),
                        resolvedBy: "test",
                      }).events
                    ),
                });
                steps.push(yield* observeWrite(input, { affected: 2, value: yield* read() }));

                if (path === "drift")
                  yield* Effect.promise(() => admin.unsafe(`UPDATE ${t} SET id=3 WHERE id=1`));

                const identity = yield* Effect.promise(async () =>
                  identityHash(await admin.unsafe<RawResult>(`SELECT id FROM ${t} WHERE v=0`).raw())
                );

                if (path === "not-previewed")
                  expect((yield* queries.execute(input)).affected).toBe(2);
                else {
                  const error = yield* Effect.flip(queries.execute(input));
                  expect(error).toMatchObject({
                    code: Match.value(path).pipe(
                      Match.when("unknown", () => "E-DATA-OUTCOME-UNKNOWN"),
                      Match.when("denied", () => "E-DATA-DENIED"),
                      Match.orElse(() => "E-DATA-SQL")
                    ),
                  });
                }

                steps.push(
                  yield* observeWrite(input, { affected: 2, value: yield* read(), identity })
                );

                if (path === "unknown")
                  expect(yield* Effect.flip(queries.execute(input))).toMatchObject({
                    code: "E-DATA-OUTCOME-UNKNOWN",
                  });
              })
            ).pipe(Effect.provide(layer))
          );
          const trace = await saveWriteTrace(`${engine}-${path}`, steps);
          expect((await replayDataWrite(trace)).steps).toBe(3);
        } finally {
          await admin.unsafe(`DROP TABLE IF EXISTS ${t}`);

          if (engine === "postgres") await admin.unsafe(`DROP FUNCTION IF EXISTS ${t}_trg()`);
          await f.close();
        }
      },
      30000
    );
  }
