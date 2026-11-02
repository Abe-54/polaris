import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setPrivateDacl } from "../platform/windowsNative.ts";
import { targetFingerprint } from "./connection.ts";
import { DataSource, DataSourceLabel, DataError } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";

const Manual = Schema.Struct({
  id: DataSource.fields.id,
  name: DataSource.fields.name,
  engine: DataSource.fields.engine,
  host: DataSource.fields.host,
  port: DataSource.fields.port,
  database: DataSource.fields.database,
  user: Schema.optionalKey(Schema.String),
  tls: DataSource.fields.tls,
  path: DataSource.fields.path,
});

export type ManualSource = typeof Manual.Type;

const decodeManual = Schema.decodeUnknownSync(Schema.fromJsonString(Manual));

const Label = Schema.Struct({ fingerprint: Schema.String, label: DataSourceLabel });

const decodeLabel = Schema.decodeUnknownOption(Schema.fromJsonString(Label));

const Rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ value: Schema.String })));

const Row = Schema.decodeUnknownSync(Schema.NullOr(Schema.Struct({ value: Schema.String })));

export const dataFailure = () =>
  new DataError({
    code: "E-DATA-UNREACHABLE",
    message: "Could not access data source storage.",
    fix: "Check the Host's private storage and Secure Storage.",
  });

export const storageCall = <A>(body: () => A) => Effect.try({ try: body, catch: dataFailure });

export const openStorage = (path: string) =>
  Effect.acquireRelease(
    storageCall(() => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const db = new Database(path, { create: true });

      try {
        if (process.platform === "win32") {
          if (!setPrivateDacl(path, "file")) throw new Error("Could not protect Data storage");
        } else chmodSync(path, 0o600);
        db.exec(`CREATE TABLE IF NOT EXISTS data_manual_sources (checkout TEXT NOT NULL, id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS data_source_labels (checkout TEXT NOT NULL, id TEXT PRIMARY KEY, value TEXT NOT NULL);`);

        return db;
      } catch (error) {
        db.close();
        throw error;
      }
    }),
    (db) => Effect.sync(() => db.close())
  );

export const sourceStorage = (db: Database) => ({
  manual: (checkout: string) =>
    storageCall(() =>
      Rows(
        db
          .query("SELECT value FROM data_manual_sources WHERE checkout = ? ORDER BY id")
          .all(checkout)
      ).map((row) => decodeManual(row.value))
    ),
  save: (checkout: string, source: ManualSource, label: DataSourceLabel, previousId = source.id) =>
    storageCall(() =>
      db.transaction(() => {
        db.query("INSERT OR REPLACE INTO data_manual_sources VALUES (?, ?, ?)").run(
          checkout,
          source.id,
          JSON.stringify(source)
        );
        db.query("INSERT OR REPLACE INTO data_source_labels VALUES (?, ?, ?)").run(
          checkout,
          source.id,
          JSON.stringify({ fingerprint: targetFingerprint(source), label })
        );

        if (previousId !== source.id) {
          db.query("DELETE FROM data_manual_sources WHERE checkout = ? AND id = ?").run(
            checkout,
            previousId
          );
          db.query("DELETE FROM data_source_labels WHERE checkout = ? AND id = ?").run(
            checkout,
            previousId
          );
        }
      })()
    ),
  remove: (checkout: string, id: string) =>
    storageCall(() =>
      db.transaction(() => {
        db.query("DELETE FROM data_manual_sources WHERE checkout = ? AND id = ?").run(checkout, id);
        db.query("DELETE FROM data_source_labels WHERE checkout = ? AND id = ?").run(checkout, id);
      })()
    ),
  label: (checkout: string, source: DataSource) =>
    storageCall(() => {
      const row = Row(
        db
          .query("SELECT value FROM data_source_labels WHERE checkout = ? AND id = ?")
          .get(checkout, source.id)
      );

      const stored = row ? Option.getOrUndefined(decodeLabel(row.value)) : undefined;

      if (stored?.fingerprint === targetFingerprint(source)) return stored.label;

      if (row)
        db.query("DELETE FROM data_source_labels WHERE checkout = ? AND id = ?").run(
          checkout,
          source.id
        );

      return undefined;
    }),
  setLabel: (checkout: string, source: DataSource, label: DataSourceLabel) =>
    storageCall(
      () =>
        void db
          .query("INSERT OR REPLACE INTO data_source_labels VALUES (?, ?, ?)")
          .run(
            checkout,
            source.id,
            JSON.stringify({ fingerprint: targetFingerprint(source), label })
          )
    ),
});
