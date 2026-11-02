/** A real DataSources and DataQueries over a temp checkout, for SQLite tests. */
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect, Layer } from "effect";
import { shortTemp } from "../../platform/testing.ts";
import { fileSecrets } from "../../secrets/index.ts";
import { DataSourceAccess } from "../access.ts";
import { DataQueries, DataSources } from "../index.ts";
import { QueryLog } from "../queryLog.ts";
import { sources } from "../sources.ts";
import { approvalLayer, seedDataSessionAt, started } from "../approvals.testing.ts";

export const sessionId = started.session.id;

export const turn = started.turns[0]!.id;

/** A temp directory removed with the scope, as its real path. */
export const tempDir = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => realpathSync(mkdtempSync(shortTemp(prefix)))),
    (root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
  );

export const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};

/** `items` (300 rows, a big integer, a blob, a long text), `notes` referencing it, and a view. */
export const seedDatabase = (file: string) => {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, safeIntegers: true });
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, big INTEGER, raw BLOB, body TEXT);
    CREATE UNIQUE INDEX items_name ON items(name);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), text TEXT DEFAULT 'none');
    CREATE VIEW item_names AS SELECT name FROM items;`);
  const insert = db.prepare("INSERT INTO items (name, big, raw, body) VALUES (?, ?, ?, ?)");

  for (let i = 1; i <= 300; i++)
    insert.run(
      `item ${i}`,
      i === 1 ? 9007199254740993n : BigInt(i),
      new Uint8Array([1, 2, i % 256]),
      i === 1 ? "x".repeat(20000) : "short"
    );
  // An unfinalized statement keeps the file open after close, and Windows can't remove it.
  insert.finalize();
  db.close();
};

export const rowCount = (file: string) => {
  const db = new Database(file, { readonly: true });

  try {
    return Number(db.query("SELECT count(*) FROM items").values()[0]?.[0]);
  } finally {
    db.close();
  }
};

/** DataSources over `checkout` and the shared DataQueries with an in-memory event store. */
export const sqliteServices = (checkout: string) => {
  const dataSources = Layer.effect(
    DataSources,
    Effect.gen(function* () {
      const access = yield* DataSourceAccess;

      return yield* sources({
        path: join(checkout, ".polaris-data.sqlite"),
        secrets: fileSecrets(join(checkout, ".polaris-secrets")),
        access,
        checkout: () => Effect.succeed(checkout),
      });
    })
  ).pipe(Layer.provide(DataSourceAccess.live));

  return DataQueries.layer.pipe(
    Layer.provideMerge(Layer.merge(dataSources, QueryLog.layer)),
    Layer.provideMerge(approvalLayer())
  );
};

export const seeded = (checkout: string) => seedDataSessionAt(checkout);
