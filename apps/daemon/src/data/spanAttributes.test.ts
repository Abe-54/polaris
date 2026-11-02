/** Data request Spans name their source and result, never their SQL or values (ENG-745). */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { DataQueries, DataSources } from "./index.ts";
import {
  seedDatabase,
  seeded,
  sessionId,
  sqliteServices,
  tempDir,
  write,
} from "./sqlite/sqlite.testing.ts";

/** A checkout whose `app` source is a SQLite file, with the real DataSources and DataQueries. */
const withApp = <A, E>(
  body: (queries: DataQueries["Service"], sources: DataSources["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-span-");
        seedDatabase(join(checkout, "app.db"));
        write(checkout, ".env", "DATABASE_URL=file:./app.db\n");

        return yield* Effect.gen(function* () {
          yield* seeded(checkout);

          return yield* body(yield* DataQueries, yield* DataSources);
        }).pipe(Effect.provide(sqliteServices(checkout)));
      })
    )
  );

/** The attributes `effect` left on the Span it ran in, whether it succeeded or failed. */
const attributesOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    yield* Effect.exit(effect);

    return Object.fromEntries(span.attributes);
  }).pipe(Effect.withSpan("polaris.rpc.test"));

const source = {
  "polaris.data.source": "app",
  "polaris.data.engine": "sqlite",
  "polaris.data.locality": "local",
};

test("describe Spans name the source, engine, locality, table and the shape returned", () =>
  withApp((queries) =>
    Effect.gen(function* () {
      expect(yield* attributesOf(queries.describe({ sessionId, source: "app" }))).toEqual({
        ...source,
        "polaris.data.described": "tree",
      });

      expect(
        yield* attributesOf(queries.describe({ sessionId, source: "app", table: "main.items" }))
      ).toEqual({
        ...source,
        "polaris.data.table": "main.items",
        "polaris.data.described": "table",
      });
    })
  ));

test("query and stream Spans carry rows, truncation and time, but no SQL or param value", () =>
  withApp((queries) =>
    Effect.gen(function* () {
      const read = {
        sessionId,
        source: "app",
        sql: "SELECT id, name FROM items WHERE name <> ? ORDER BY id",
        params: ["secret-param-value"],
      };

      const query = yield* attributesOf(queries.query({ ...read, limit: 5 }));

      const stream = yield* attributesOf(
        Stream.runDrain(queries.queryStream({ ...read, limit: 1000 }))
      );

      expect(query).toMatchObject({
        ...source,
        "polaris.data.rows": 5,
        "polaris.data.truncated": true,
      });
      expect(stream).toMatchObject({
        ...source,
        "polaris.data.rows": 300,
        "polaris.data.truncated": false,
      });

      for (const attributes of [query, stream]) {
        expect(attributes["polaris.data.elapsed_ms"]).toBeNumber();
        const text = JSON.stringify(attributes);
        expect(text).not.toContain("SELECT");
        expect(text).not.toContain("items");
        expect(text).not.toContain("secret-param-value");
        expect(text).not.toContain("app.db");
      }
    })
  ));

test("an access change Span names the source and the change asked for, even when refused", () =>
  withApp((_, sources) =>
    Effect.gen(function* () {
      expect(
        yield* attributesOf(sources.access({ sessionId, source: "app", writes: "off" }))
      ).toEqual({
        ...source,
        "polaris.data.access.writes": "off",
        "polaris.data.access.revoke": false,
      });
    })
  ));
