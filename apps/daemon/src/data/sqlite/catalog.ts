/** SQLite's catalog (sqlite_schema and the table pragmas) as Polaris schema trees and table details. */
import { DataError, SchemaTree, TableDetail, scrubCredentials } from "@polaris/protocol";
import { Effect, Schema } from "effect";
import type { CatalogSnapshot, SnapshotTable } from "../schemaCompare.ts";
import { fingerprint, scrubCatalogText } from "../schemaScrub.ts";
import { sqliteCatalogRead } from "./client.ts";
import type { CatalogRelation } from "./jobs.ts";

/** SQLite's only user schema; attached databases are never opened. */
export const SQLITE_SCHEMA = "main";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const missingTable = () =>
  new DataError({
    code: "E-DATA-SQL",
    message: "This table does not exist in this SQLite file.",
    fix: "List the data source schema and select a table from it.",
  });

const visible = (relation: CatalogRelation) =>
  relation.columns.filter((column) => column.hidden === 0 || column.hidden >= 2);

const summary = (relation: CatalogRelation) => ({
  name: relation.name,
  rowEstimate: null,
  columnCount: visible(relation).length,
  columns: visible(relation)
    .slice(0, 256)
    .map((column) => ({ name: column.name, type: column.type })),
});

export const sqliteTree = (file: string) =>
  Effect.map(sqliteCatalogRead(file, undefined, false), (output) => {
    const tables = output.relations.filter((relation) => !relation.view);
    const views = output.relations.filter((relation) => relation.view);

    return new SchemaTree({
      loadedAt: new Date().toISOString(),
      schemas: [
        {
          name: SQLITE_SCHEMA,
          tables: tables.map(summary),
          views: views.map(summary),
          functions: [],
        },
      ],
      truncatedTables: Math.max(0, output.total - 500),
    });
  });

function detail(relation: CatalogRelation, scrub: (text: string) => string = (text) => text) {
  const columns = visible(relation).slice(0, 256);

  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

  const unique = relation.indexes.filter((index) => index.unique);

  return {
    schema: SQLITE_SCHEMA,
    name: relation.name,
    primaryKey,
    rowEstimate: null,
    columns: columns.map((column) => {
      const fk = relation.foreignKeys.find((key) => key.from === column.name);

      const generated = column.hidden === 3 ? "stored" : "virtual";

      const base = {
        name: column.name,
        type: column.type,
        nullable: !column.notnull && column.pk === 0,
        default: column.default === null ? null : scrub(column.default),
        fingerprint: fingerprint(JSON.stringify([column.default, column.hidden])),
        pk: column.pk > 0,
        fk:
          fk === undefined
            ? null
            : { schema: SQLITE_SCHEMA, table: fk.table, column: fk.to ?? "rowid" },
      };

      return column.hidden >= 2 ? { ...base, generated } : base;
    }),
    indexes: relation.indexes.slice(0, 256).map((index) => ({
      name: index.name,
      columns: index.columns.map(scrub),
      unique: index.unique,
      definition: scrub(
        index.sql ??
          `${index.origin === "pk" ? "PRIMARY KEY" : "UNIQUE"} (${index.columns.join(", ")})`
      ),
      fingerprint: fingerprint(JSON.stringify([index.columns, index.sql])),
    })),
    constraints: [
      ...(primaryKey.length > 0
        ? [
            {
              name: "primary key",
              kind: "PRIMARY KEY",
              definition: `PRIMARY KEY (${primaryKey.join(", ")})`,
            },
          ]
        : []),
      ...unique
        .filter((index) => index.origin === "u")
        .map((index) => ({
          name: index.name,
          kind: "UNIQUE",
          definition: `UNIQUE (${index.columns.join(", ")})`,
        })),
      ...relation.foreignKeys.map((key) => ({
        name: `${key.from} → ${key.table}`,
        kind: "FOREIGN KEY",
        definition: `FOREIGN KEY (${key.from}) REFERENCES ${key.table}(${key.to ?? "rowid"})`,
      })),
    ].map((constraint) => ({
      ...constraint,
      fingerprint: fingerprint(constraint.definition),
    })),
  };
}

/** One table's detail and the SQL that samples it. */
export const sqliteTable = (file: string, table: string) =>
  Effect.gen(function* () {
    const output = yield* sqliteCatalogRead(file, table, true);
    const relation = output.relations[0];

    if (relation === undefined) return yield* missingTable();

    return {
      detail: new TableDetail(detail(relation)),
      sampleSql: `SELECT * FROM ${quote(SQLITE_SCHEMA)}.${quote(relation.name)}`,
    };
  });

/** The schema snapshot of every table, for schema changes between Turns. */
export const sqliteSnapshot = (file: string) =>
  Effect.map(sqliteCatalogRead(file, undefined, true), (output): CatalogSnapshot => {
    const scrub = (text: string) => scrubCatalogText(scrubCredentials(text));

    const tables: SnapshotTable[] = output.relations
      .filter((relation) => !relation.view)
      .map((relation) => ({
        ...Schema.encodeSync(TableDetail)(new TableDetail(detail(relation, scrub))),
        ...(relation.columns.length > 256 || relation.indexes.length > 256
          ? { detailsTruncated: true }
          : undefined),
      }));

    return { at: new Date().toISOString(), tables, truncated: output.total > 500 };
  });
