/** Opt-in RSD W7 fixture; fake catalog boundary, real worker and SQLite. */
import { expect, test } from "bun:test";
import { TableDetail, Turn, TurnId } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import { fixture, snapshotLayer, turn } from "./schemaSnapshots.testing.ts";

test.skipIf(!process.env.POLARIS_SCHEMA_COST && !process.env.POLARIS_TEST_PG_URL)(
  "W7: cost after 200 unused migration-capable Turns",
  async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const tables = Array.from(
            { length: 500 },
            (_, i) =>
              new TableDetail({
                schema: "public",
                name: `table_${i}`,
                columns: Array.from({ length: 12 }, (_, c) => ({
                  name: `column_${c}`,
                  type: "character varying(255)",
                  nullable: true,
                  default: null,
                  pk: false,
                  fk: null,
                })),
                indexes: [
                  {
                    name: `table_${i}_pkey`,
                    columns: ["column_0"],
                    unique: true,
                    definition: `CREATE UNIQUE INDEX table_${i}_pkey ON public.table_${i} USING btree (column_0)`,
                  },
                ],
                constraints: [
                  { name: `table_${i}_pkey`, kind: "p", definition: "PRIMARY KEY (column_0)" },
                ],
                rowEstimate: 1000,
              })
          );

          let captures = 0;

          const f = yield* fixture({
            capture: () =>
              Effect.sync(() => {
                captures++;

                return { at: new Date().toISOString(), tables, truncated: false };
              }),
            migrationChanged: () => Promise.resolve(false),
          });

          const fields = Schema.decodeUnknownSync(Schema.Struct(Turn.fields))(turn);
          const t = (i: number) => new Turn({ ...fields, index: i, id: TurnId.make(`t${i}`) });

          for (let i = 0; i < 200; i++) {
            yield* f.worker.begin(t(i));
            yield* f.worker.end(t(i));
          }

          const stored = f.records.bytes();
          const t0 = performance.now();
          f.records.records(turn.sessionId, "t199");
          const one = performance.now() - t0;
          const t1 = performance.now();
          yield* f.worker.begin(t(200));
          const begin = performance.now() - t1;
          const t2 = performance.now();
          yield* f.worker.get({ sessionId: turn.sessionId });
          const get = performance.now() - t2;
          console.log(
            `W7 rows=${f.records.records(turn.sessionId).length} stored=${(stored / 1048576).toFixed(3)} MiB, one-Turn records()=${one.toFixed(2)} ms, begin()=${begin.toFixed(2)} ms, get(session)=${get.toFixed(2)} ms, captures=${captures}`
          );
          expect(captures).toBe(1);
          expect(stored).toBeLessThan(2 * 1048576);
          expect((yield* f.worker.get({ sessionId: turn.sessionId, turn: t(0).id })).pruned).toBe(
            true
          );
        })
      ).pipe(Effect.provide(snapshotLayer()))
    );
  },
  900000
);
