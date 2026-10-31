/** Pure catalog comparison; ambiguous column matches remain additions/removals. */
import type { SchemaTableDiff, TableDetail } from "@polaris/protocol";

export interface CatalogSnapshot {
  readonly at: string;
  readonly tables: ReadonlyArray<TableDetail>;
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

// A rename may also add columns; require a unique, same-schema superset of the old columns.
const renameMatch = (a: TableDetail, b: TableDetail) =>
  a.schema === b.schema &&
  a.columns.length > 0 &&
  a.columns.every((c) => b.columns.some((d) => c.name === d.name && c.type === d.type));

const rowsChanged = (
  before: TableDetail | undefined,
  after: TableDetail | undefined,
  affected: ReadonlyArray<AffectedTable>
): SchemaTableDiff["rows"] => {
  const hits = affected.filter((x) =>
    [before, after].some(
      (t) => t && x.table === t.name && (x.schema === t.schema || x.schema === undefined)
    )
  );

  if (hits.length)
    return {
      kind: "exact",
      value: hits.reduce((n, x) => n + x.rows, 0),
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
  affected: ReadonlyArray<AffectedTable> = []
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
  const pairs: Array<[TableDetail | undefined, TableDetail | undefined]> = [];

  for (const [id, table] of a)
    if (b.has(id)) {
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
      partial ? items.filter((x) => x.before !== null && x.after !== null) : items;

    const columns = visible(changes(old?.columns ?? [], next?.columns ?? []));
    const indexes = visible(changes(old?.indexes ?? [], next?.indexes ?? []));
    const constraints = visible(changes(old?.constraints ?? [], next?.constraints ?? []));
    const rows = rowsChanged(old, next, qualified);
    const renamed = old && next && key(old) !== key(next);

    if (
      old &&
      next &&
      !renamed &&
      !columns.length &&
      !indexes.length &&
      !constraints.length &&
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
        rows,
      },
    ];
  });
};
