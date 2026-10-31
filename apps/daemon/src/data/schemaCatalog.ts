/** Bounded metadata snapshots use the catalog reader without the approval-opening path. */
import { SchemaTree } from "@polaris/protocol";
import { Effect } from "effect";
import { readCatalog } from "./catalog.ts";
import { DataPools } from "./pools.ts";
import type { DataSources } from "./index.ts";
import type { CatalogSnapshot } from "./schemaCompare.ts";

export type ResolvedSource = Effect.Success<ReturnType<DataSources["Service"]["resolve"]>>;

export const snapshotAllowed = (resolved: ResolvedSource) =>
  resolved.source.access !== "denied" &&
  (resolved.source.locality === "local" || resolved.source.access === "approved");

export const snapshotCatalog = Effect.fnUntraced(function* (
  pools: DataPools,
  resolved: ResolvedSource
) {
  const tree = yield* readCatalog(pools, resolved);

  if (!(tree instanceof SchemaTree)) return yield* Effect.die("Expected catalog tree");
  const tables = [];

  for (const group of tree.schemas)
    for (const table of group.tables) {
      if (tables.length >= 500) break;

      const name =
        resolved.source.engine === "postgres"
          ? `"${group.name.replaceAll('"', '""')}"."${table.name.replaceAll('"', '""')}"`
          : table.name;

      const result = yield* readCatalog(pools, resolved, name, tree);

      if (!(result instanceof SchemaTree)) tables.push(result.detail);
    }

  return {
    at: new Date().toISOString(),
    tables,
    truncated:
      tree.truncatedTables > 0 ||
      tables.some(
        (t) => t.columns.length >= 256 || t.indexes.length >= 256 || t.constraints.length >= 256
      ),
  } satisfies CatalogSnapshot;
});
