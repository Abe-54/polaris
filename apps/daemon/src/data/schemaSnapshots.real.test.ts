import { shortTemp } from "../platform/testing.ts";
/** Run only against disposable operator-provided Postgres16/MySQL8.4 databases. */
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DataSource } from "@polaris/protocol";
import { Effect, Redacted } from "effect";
import { parseConnection } from "./connection.ts";
import { DataPools, sqlOptions } from "./pools.ts";
import { snapshotCatalog } from "./schemaCatalog.ts";
import { migrationCheckout, migrationChanged } from "./schemaMigrations.ts";
import { captureCheckpoint } from "../git/Checkpoints.ts";
import { runGitRaw } from "../git/git.ts";
import { fixture, snapshotLayer, turn } from "./schemaSnapshots.testing.ts";

for (const engine of ["postgres", "mysql"] as const) {
  const url = process.env[engine === "postgres" ? "POLARIS_TEST_PG_URL" : "POLARIS_TEST_MYSQL_URL"];
  test.skipIf(!url)(
    `${engine}: a migration Turn adds a column/index and renames a table in Schema Diff`,
    async () => {
      const parsed = parseConnection({
        name: "app",
        url: Redacted.make(url!),
        foundIn: { kind: "manual" },
      })!;

      const source = new DataSource({
        id: "source",
        name: "app",
        engine,
        host: parsed.connection.hostname,
        port: parsed.connection.port,
        database: parsed.connection.database,
        user: parsed.connection.username,
        locality: "local",
        foundIn: { kind: "manual" },
        access: "read",
        writes: "ask",
        label: { text: "LOCAL", colour: "none" },
      });

      const admin = new SQL({
        ...sqlOptions(source, parsed.connection),
        allowPublicKeyRetrieval: engine === "mysql",
      });

      const pools = new DataPools();
      const prefix = `sd_${crypto.randomUUID().replaceAll("-", "")}`;
      const before = `${prefix}_old`;
      const after = `${prefix}_new`;
      const index = `${prefix}_idx`;
      const root = mkdtempSync(shortTemp("polaris-schema-"));

      try {
        expect((await runGitRaw(root, ["init"])).code).toBe(0);
        mkdirSync(join(root, "prisma/migrations"), { recursive: true });
        const file = join(root, "prisma/migrations/001.sql");
        writeFileSync(file, "-- before\n");
        await admin.unsafe(`CREATE TABLE ${before} (id INT PRIMARY KEY)`);
        await admin.unsafe(`INSERT INTO ${before} VALUES (1)`);

        if (engine === "postgres") await admin.unsafe(`ANALYZE ${before}`);
        expect(
          await captureCheckpoint({
            cwd: root,
            sessionId: turn.sessionId,
            turnId: turn.id,
            label: "before",
          })
        ).not.toBeNull();
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const f = yield* fixture({
                checkout: root,
                resolved: { source, connection: parsed.connection, matchUrl: Redacted.make(url!) },
                capture: (resolved) => snapshotCatalog(pools, resolved),
                migrationCheckout,
                migrationChanged,
              });

              yield* f.worker.begin(turn);
              yield* Effect.promise(async () => {
                await admin.unsafe(`ALTER TABLE ${before} ADD COLUMN note VARCHAR(128)`);
                await admin.unsafe(`CREATE INDEX ${index} ON ${before} (note)`);
                await admin.unsafe(`ALTER TABLE ${before} RENAME TO ${after}`);

                if (engine === "postgres") await admin.unsafe(`ANALYZE ${after}`);
                writeFileSync(
                  file,
                  `ALTER TABLE ${before} ADD COLUMN note VARCHAR(128);\nCREATE INDEX ${index} ON ${before} (note);\nALTER TABLE ${before} RENAME TO ${after};\n`
                );
                await captureCheckpoint({
                  cwd: root,
                  sessionId: turn.sessionId,
                  turnId: turn.id,
                  label: "after",
                });
              });
              yield* f.worker.end(turn);
              const result = yield* f.worker.get({ sessionId: turn.sessionId, turn: turn.id });
              expect(result.sources[0]?.status).toBe("complete");
              const change = result.sources[0]?.tables.find((t) => t.before?.name === before);
              expect(change).toMatchObject({
                kind: "renamed",
                after: { name: after },
                columns: [{ name: "note", before: null, after: { nullable: true } }],
              });
              expect(
                change?.indexes.some(
                  (x) => x.name === index && x.before === null && x.after?.columns.includes("note")
                )
              ).toBe(true);
              expect(change?.rows.kind).toBe("estimate");
              yield* f.worker.remove(turn.sessionId);
              expect(f.records.records(turn.sessionId)).toEqual([]);
            })
          ).pipe(Effect.provide(snapshotLayer()))
        );
      } finally {
        await admin.unsafe(`DROP TABLE IF EXISTS ${before}`);
        await admin.unsafe(`DROP TABLE IF EXISTS ${after}`);
        await pools.close();
        await admin.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60000
  );
}
