/** Bounded metadata snapshots never open approvals; every relation set is read in one query. */
import { DataError, TableDetail, scrubCredentials } from "@polaris/protocol";
import { Effect, Option, Schema } from "effect";
import { type CatalogRow } from "./catalog.ts";
import { catalogError, catalogValues } from "./catalogValues.ts";
import { readEffect, knownCredentials } from "./execution.ts";
import { DataPools } from "./pools.ts";
import type { DataSources } from "./index.ts";
import type { CatalogSnapshot, SnapshotTable } from "./schemaCompare.ts";
import { fingerprint, scrubCatalogText } from "./schemaScrub.ts";
import { MYSQL_SNAPSHOT_TABLES, snapshotSql } from "./schemaCatalogSql.ts";
import { serverEngine } from "./engine.ts";

export type ResolvedSource = Effect.Success<ReturnType<DataSources["Service"]["resolve"]>>;

export const snapshotAllowed = (resolved: ResolvedSource) =>
  resolved.source.access !== "denied" &&
  (resolved.source.locality === "local" || resolved.source.access === "approved");

const Strings = Schema.Array(Schema.String);

const ForeignKey = Schema.NullOr(
  Schema.Struct({ schema: Schema.String, table: Schema.String, column: Schema.String })
);

export const makeSnapshotCatalog = (read: typeof readEffect) =>
  Effect.fnUntraced(
    function* (pools: DataPools, resolved: ResolvedSource) {
      const at = new Date().toISOString();
      const engine = serverEngine(resolved.source.engine);
      const sql = snapshotSql[engine];
      const { plain, text, number, bool, json, decode } = catalogValues(engine);

      const scrub = (value: string) =>
        scrubCatalogText(scrubCredentials(value, knownCredentials(resolved.connection)));

      let selected: ReadonlyArray<string> = [];

      const rows = Effect.fnUntraced(function* (
        statement: string,
        limit: number = 500 * 257,
        bound: ReadonlyArray<string> = []
      ) {
        let sql = statement;
        let params: ReadonlyArray<string> = bound;

        if (engine === "mysql" && statement.includes(MYSQL_SNAPSHOT_TABLES)) {
          params = bound.length ? bound : selected;

          if (statement === snapshotSql.mysql.identities)
            params = selected.map((name) => `${resolved.source.database}/${name}`);
          sql = statement.replaceAll(
            MYSQL_SNAPSHOT_TABLES,
            params.length ? params.map(() => "?").join(",") : "NULL"
          );
        }

        const result = yield* read(pools, { ...resolved, sql, params, limit, catalogText: true });

        return result.rows.map((row) =>
          Object.fromEntries<Schema.Json | undefined>(
            result.columns.map((c, i) => [c.name, plain(c.name, row[i])])
          )
        );
      });

      const tree = yield* rows(sql.tables, 501);
      selected = tree.slice(0, 500).map((row) => text("table.name", row.name));
      const columns = yield* rows(sql.columns);
      const indexes = yield* rows(sql.indexes);
      let constraints = yield* rows(sql.constraints);

      if (engine === "mysql") {
        const names = constraints
          .filter((row) => text("constraint.kind", row.kind) === "CHECK")
          .map((row) => text("constraint.name", row.name));

        const definitions = new Map<string, Schema.Json | undefined>();

        for (let i = 0; i < names.length; i += 60000) {
          const batch = names.slice(i, i + 60000);

          const checks = yield* rows(snapshotSql.mysql.checks, batch.length, batch);

          for (const check of checks)
            definitions.set(text("check.name", check.name), check.definition);
        }

        constraints = constraints.map((row) =>
          text("constraint.kind", row.kind) === "CHECK"
            ? {
                ...row,
                definition: definitions.get(text("constraint.name", row.name)) ?? "[unavailable]",
                unavailable: !definitions.has(text("constraint.name", row.name)),
              }
            : row
        );
      }

      const objects = yield* rows(sql.objects);

      // InnoDB identity needs PROCESS on some installations; absence must never guess a rename.
      const identities =
        engine === "mysql"
          ? yield* rows(snapshotSql.mysql.identities, 501).pipe(
              Effect.catch((error) =>
                error.code === "E-DATA-SQL" || error.code === "E-DATA-DENIED"
                  ? Effect.succeed([])
                  : Effect.fail(error)
              )
            )
          : [];

      const total =
        engine === "postgres"
          ? number("total", (yield* rows(snapshotSql.postgres.total, 1))[0]?.total)
          : number("total", tree[0]?.total ?? 0);

      const group = (items: CatalogRow[]) => {
        const result = new Map<string, CatalogRow[]>();

        for (const item of items) {
          const id = text("relation_id", item.relation_id);
          const list = result.get(id) ?? [];
          list.push(item);
          result.set(id, list);
        }

        return result;
      };

      const cs = group(columns),
        ix = group(indexes),
        co = group([...constraints, ...objects]);

      const tables: SnapshotTable[] = tree.slice(0, 500).map((row) => {
        const id = text("table.id", row.relation_id);
        const schema = text("table.schema", row.schema_name);
        const name = text("table.name", row.name);

        const cols = cs.get(id) ?? [],
          idx = ix.get(id) ?? [],
          cons = co.get(id) ?? [];

        const stable =
          engine === "postgres"
            ? row.identity
            : identities.find((x) => x.name === `${schema}/${name}`)?.identity;

        const detail = decode("table", TableDetail, {
          schema,
          name,
          rowEstimate: row.estimate === null ? null : number("estimate", row.estimate),
          columns: cols.slice(0, 256).map((c) => ({
            name: text("column.name", c.name),
            type: text("column.type", c.type),
            nullable: bool("column.nullable", c.nullable),
            default:
              c.default_value == null
                ? null
                : engine === "mysql"
                  ? "[redacted]"
                  : scrub(text("column.default", c.default_value)),
            fingerprint: fingerprint(
              JSON.stringify([c.default_value, c.generated_expression, c.extra])
            ),
            ...(c.generated_expression == null
              ? undefined
              : { generated: scrub(text("column.generated", c.generated_expression)) }),
            ...(c.collation_name == null
              ? undefined
              : { collation: text("column.collation", c.collation_name) }),
            ...(c.extra == null ? undefined : { extra: scrub(text("column.extra", c.extra)) }),
            pk: bool("column.pk", c.pk),
            fk: json("column.fk", ForeignKey, c.fk),
          })),
          indexes: idx.slice(0, 256).map((i) => ({
            name: text("index.name", i.name),
            fingerprint: fingerprint(JSON.stringify([i.columns, i.definition])),
            columns: json("index.columns", Strings, i.columns).map(scrub),
            unique: bool("index.unique", i.is_unique),
            definition: scrub(text("index.definition", i.definition)),
          })),
          constraints: cons.slice(0, 256).map((c) => ({
            name: text("constraint.name", c.name),
            fingerprint: fingerprint(JSON.stringify(c.definition ?? null)),
            kind: text("constraint.kind", c.kind),
            definition: scrub(text("constraint.definition", c.definition ?? "")),
          })),
        });

        return {
          ...Schema.encodeSync(TableDetail)(detail),
          ...(stable == null ? undefined : { identity: text("identity", stable) }),
          ...(Math.max(cols.length, idx.length, cons.length) > 256 ||
          cons.some((c) => c.unavailable === true)
            ? { detailsTruncated: true }
            : undefined),
        };
      });

      return { at, tables, truncated: total > 500 } satisfies CatalogSnapshot;
    },
    (effect, _pools, resolved) =>
      effect.pipe(
        Effect.catchDefect((cause) => {
          const parsed = Schema.decodeUnknownOption(DataError)(cause);

          return Effect.fail(
            Option.isSome(parsed) ? parsed.value : catalogError(resolved.source.engine, "result")
          );
        })
      )
  );

export const snapshotCatalog = makeSnapshotCatalog(readEffect);
