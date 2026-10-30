/**
 * A Data Source's schema as the SQL tab completes it (ENG-649): tables with their row estimate,
 * columns with their type, nullability and foreign key target. Metadata only, never rows.
 */
import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";
import type { SchemaTree, TableDetail } from "@polaris/protocol";

export interface CatalogColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly pk: boolean;
  readonly fk: { readonly schema: string; readonly table: string; readonly column: string } | null;
}

export interface CatalogTable {
  readonly schema: string;
  readonly name: string;
  readonly rowEstimate: number | null;
  /** Null until the table's detail has been read. */
  readonly columns: ReadonlyArray<CatalogColumn> | null;
}

export interface Catalog {
  readonly tables: ReadonlyArray<CatalogTable>;
  /** The schema whose tables complete without a prefix: `public`, or a MySQL database. */
  readonly defaultSchema: string | null;
}

/** "214", "1.3k", "2.1M": a row estimate as the sidebar and completion print it. */
export const shortCount = (n: number): string => {
  if (n < 1000) return String(n);

  if (n < 1_000_000) return `${trim(n / 1000)}k`;

  return `${trim(n / 1_000_000)}M`;
};

const trim = (n: number) =>
  n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, "");

const detailKey = (schema: string, table: string) => `${schema}.${table}`;

/** The tree's tables, with columns from whichever details have been read. */
export const catalogOf = (
  tree: SchemaTree,
  details: ReadonlyMap<string, TableDetail> = new Map()
): Catalog => {
  const tables = tree.schemas.flatMap((schema) =>
    [...schema.tables, ...schema.views].map((table): CatalogTable => {
      const detail = details.get(detailKey(schema.name, table.name));

      return {
        schema: schema.name,
        name: table.name,
        rowEstimate: table.rowEstimate,
        columns: detail?.columns ?? null,
      };
    })
  );

  const names = tree.schemas.map((s) => s.name);

  return { tables, defaultSchema: names.includes("public") ? "public" : (names[0] ?? null) };
};

export const catalogDetailKey = detailKey;

/** "char(3) · nullable", "uuid → customers.id", "uuid · primary key". */
export const columnDetail = (column: CatalogColumn): string => {
  if (column.fk !== null) return `${column.type} → ${column.fk.table}.${column.fk.column}`;

  if (column.pk) return `${column.type} · primary key`;

  return column.nullable ? `${column.type} · nullable` : column.type;
};

const rows = (table: CatalogTable) =>
  table.rowEstimate === null ? "rows unknown" : `${shortCount(table.rowEstimate)} rows`;

/** The info line under a column: "invoices.currency · 1.3k rows". */
export const columnInfo = (table: CatalogTable, column: CatalogColumn): string =>
  `${table.name}.${column.name} · ${rows(table)}`;

export const tableDetail = (table: CatalogTable): string =>
  table.columns === null ? rows(table) : `${rows(table)} · ${table.columns.length} columns`;

const columnCompletion = (table: CatalogTable, column: CatalogColumn): Completion => ({
  label: column.name,
  type: "property",
  detail: columnDetail(column),
  info: columnInfo(table, column),
  boost: column.pk ? 1 : 0,
});

const tableCompletion = (table: CatalogTable): Completion => ({
  label: table.name,
  type: "type",
  detail: tableDetail(table),
  info: `${table.schema}.${table.name}`,
});

const tableEntry = (table: CatalogTable): SQLNamespace => ({
  self: tableCompletion(table),
  children: (table.columns ?? []).map((column) => columnCompletion(table, column)),
});

/** lang-sql's `schema`: schema → table → columns, each with its detail and info. */
export const sqlNamespace = (catalog: Catalog): SQLNamespace => {
  const schemas = new Map<string, Record<string, SQLNamespace>>();

  for (const table of catalog.tables) {
    const tables = schemas.get(table.schema) ?? {};

    tables[table.name] = tableEntry(table);
    schemas.set(table.schema, tables);
  }

  return Object.fromEntries(schemas);
};
