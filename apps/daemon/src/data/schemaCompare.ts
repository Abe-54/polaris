/** Pure catalog comparison; ambiguous column matches remain additions/removals. */
import type { SchemaTableDiff, TableDetail } from "@polaris/protocol";

export interface SnapshotTable extends TableDetail {
  readonly identity?: string;
  readonly detailsTruncated?: boolean;
}

export interface CatalogSnapshot {
  readonly at: string;
  readonly tables: ReadonlyArray<SnapshotTable>;
  readonly truncated: boolean;
}

export interface AffectedTable {
  readonly schema?: string;
  readonly table: string;
  readonly rows: number;
  readonly author: "agent" | "user";
}

const key = (t: { schema: string; name: string }) => JSON.stringify([t.schema, t.name]);

const same = <T extends { readonly name: string }>(a: T | undefined, b: T | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

const identity = (t: TableDetail | undefined) => (t ? { schema: t.schema, name: t.name } : null);

const changes = <T extends { readonly name: string }>(
  before: ReadonlyArray<T>,
  after: ReadonlyArray<T>
) => {
  const a = new Map(before.map((x) => [x.name, x]));
  const b = new Map(after.map((x) => [x.name, x]));

  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .flatMap((name) =>
      same(a.get(name), b.get(name))
        ? []
        : [{ name, before: a.get(name) ?? null, after: b.get(name) ?? null }]
    );
};

// Only engine identity can establish a rename; equal columns do not preserve data.
const renameMatch = (a: SnapshotTable, b: SnapshotTable) =>
  a.identity !== undefined && a.identity === b.identity;

const rowsChanged = (
  before: TableDetail | undefined,
  after: TableDetail | undefined,
  affected: ReadonlyArray<AffectedTable>,
  uncertain: boolean
): SchemaTableDiff["rows"] => {
  const hits = affected.filter((x) =>
    [before, after].some(
      (t) => t && x.table === t.name && (x.schema === t.schema || x.schema === undefined)
    )
  );

  if (hits.length)
    return {
      kind: uncertain ? "unknown" : "exact",
      value: uncertain ? null : hits.reduce((n, x) => n + x.rows, 0),
      agent: hits.filter((x) => x.author === "agent").reduce((n, x) => n + x.rows, 0),
      user: hits.filter((x) => x.author === "user").reduce((n, x) => n + x.rows, 0),
    };
  const a = before ? before.rowEstimate : 0;
  const b = after ? after.rowEstimate : 0;

  return a === null || b === null
    ? { kind: "unknown", value: null }
    : { kind: "estimate", value: b - a };
};

export const compareCatalogs = (
  before: CatalogSnapshot,
  after: CatalogSnapshot,
  affected: ReadonlyArray<AffectedTable> = [],
  uncertain = false
): ReadonlyArray<SchemaTableDiff> => {
  const qualified = affected.filter(
    (x) =>
      x.schema !== undefined ||
      new Set(
        [...before.tables, ...after.tables].flatMap((t) => (t.name === x.table ? [t.schema] : []))
      ).size === 1
  );

  const a = new Map(before.tables.map((t) => [key(t), t]));
  const b = new Map(after.tables.map((t) => [key(t), t]));
  const pairs: Array<[SnapshotTable | undefined, SnapshotTable | undefined]> = [];

  for (const [id, table] of a)
    if (
      b.has(id) &&
      (!table.identity || !b.get(id)?.identity || table.identity === b.get(id)?.identity)
    ) {
      pairs.push([table, b.get(id)]);
      a.delete(id);
      b.delete(id);
    }

  const partial = before.truncated || after.truncated;

  if (!partial) {
    for (const [id, table] of a) {
      const matches = [...b.values()].filter((t) => renameMatch(table, t));
      const candidate = matches[0];

      if (
        matches.length !== 1 ||
        !candidate ||
        [...a.values()].filter((t) => renameMatch(t, candidate)).length !== 1
      )
        continue;
      pairs.push([table, candidate]);
      a.delete(id);
      b.delete(key(candidate));
    }

    for (const table of a.values()) pairs.push([table, undefined]);

    for (const table of b.values()) pairs.push([undefined, table]);
  }

  return pairs.flatMap(([old, next]): SchemaTableDiff[] => {
    const visible = <T extends { before: unknown; after: unknown }>(items: T[]) =>
      old?.detailsTruncated || next?.detailsTruncated
        ? items.filter((x) => x.before !== null && x.after !== null)
        : items;

    const columns = visible(changes(old?.columns ?? [], next?.columns ?? []));
    const indexes = visible(changes(old?.indexes ?? [], next?.indexes ?? []));
    const constraints = visible(changes(old?.constraints ?? [], next?.constraints ?? []));
    const rows = rowsChanged(old, next, qualified, uncertain);
    const renamed = old && next && key(old) !== key(next);

    if (
      old &&
      next &&
      !renamed &&
      !columns.length &&
      !indexes.length &&
      !constraints.length &&
      !uncertain &&
      rows.kind !== "exact" &&
      (rows.value === 0 || rows.value === null)
    )
      return [];

    return [
      {
        kind: old ? (next ? (renamed ? "renamed" : "changed") : "removed") : "added",
        before: identity(old),
        after: identity(next),
        columns,
        indexes,
        constraints,
        ...(old?.detailsTruncated || next?.detailsTruncated
          ? { detailsTruncated: true }
          : undefined),
        rows,
      },
    ];
  });
};
