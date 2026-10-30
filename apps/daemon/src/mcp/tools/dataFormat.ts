/** Text-first Data output; the JSON view uses the same sanitized, clipped values. */
import { Schema, Predicate, type Redacted } from "effect";
import { SchemaTree, type DataSource, type QueryResult, type TableDetail } from "@polaris/protocol";

import { scrubKnown } from "../../data/knownCredentials.ts";

export const DATA_TEXT_LIMIT = 16_000;

const sensitive = /password|passwd|secret|token|credential|connection.?string|database.?url/i;

/** Scrub credentials before clipping: a clipped URL must never expose its prefix. */
type Known = ReadonlyArray<Redacted.Redacted<string>>;

export const safeDataText = (value: string, known: Known = []): string =>
  scrubKnown(value, known)
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(
      /\b(password|passwd|pwd|token|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]"
    )
    .replace(/[\r\n\t]/g, " ");

const clip = (value: string) =>
  value.length > 200 ? `${value.slice(0, 200)}…(+${value.length - 200} chars)` : value;

type DataCell = QueryResult["rows"][number][number];

export const dataValue = (
  value: DataCell,
  key = "",
  known: Known = []
): typeof Schema.Json.Type => {
  if (sensitive.test(key)) return "[redacted]";

  if (value === null || value === undefined) return null;

  if (value instanceof Uint8Array) return `<bytes ${value.byteLength}>`;

  if (value instanceof Date) return value.toISOString();

  if (Predicate.isString(value)) return clip(safeDataText(value, known));

  if (Predicate.isBigInt(value)) return value.toString();

  if (Array.isArray(value)) return value.map((item) => dataValue(item, "", known));

  if (Predicate.isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [safeDataText(k, known), dataValue(v, k, known)])
    );

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) return value;

  return "[unsupported value]";
};

const dataObject = (value: DataCell, known: Known) =>
  Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(dataValue(value, "", known));

const cell = (value: typeof Schema.Json.Type) =>
  value === null ? "NULL" : Predicate.isString(value) ? value : JSON.stringify(value);

export const aligned = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths: number[] = [];

  for (const row of rows)
    row.forEach((value, i) => {
      widths[i] = Math.max(widths[i] ?? 0, value.length);
    });

  return rows.map((row) =>
    row
      .map((value, i) => value.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd()
  );
};

export const queryView = (result: QueryResult, known: Known = []) => {
  const columns = result.columns.map(({ name, type }) => ({
    name: safeDataText(name, known),
    type: safeDataText(type, known),
  }));

  const rows = result.rows.map((row) =>
    row.map((value, i) => dataValue(value, result.columns[i]?.name, known))
  );

  const queryId = safeDataText(result.queryId, known);
  const header = `${result.rowCount.toLocaleString("en-US")} rows · ${result.elapsedMs} ms · query ${queryId}`;

  const rendered = aligned([
    columns.map((column) => `${column.name} (${column.type})`),
    ...rows.map((row) => row.map(cell)),
  ]);

  let kept = rows.length;

  const tail = () =>
    `${kept} of ${result.rowCount.toLocaleString("en-US")} rows; add a WHERE or an aggregate`;

  const text = () =>
    [
      header,
      ...rendered.slice(0, kept + 1),
      ...(kept < rows.length || result.truncated ? [tail()] : []),
    ].join("\n");

  while (kept > 0 && text().length > DATA_TEXT_LIMIT) kept--;
  let output = text();

  if (output.length > DATA_TEXT_LIMIT)
    output = `${header}\nColumn headers omitted; select fewer columns.\n${tail()}`;

  return {
    text: output,
    data: {
      queryId,
      columns,
      rows: rows.slice(0, kept),
      rowCount: result.rowCount,
      truncated: result.truncated || kept < rows.length,
      elapsedMs: result.elapsedMs,
    },
  };
};

const foundIn = (source: DataSource) =>
  source.foundIn.kind === "manual"
    ? "added by you"
    : `from ${source.foundIn.file ?? source.foundIn.kind}${source.foundIn.key === undefined ? "" : ` (${source.foundIn.key})`}`;

const access = (source: DataSource) => {
  if (source.access === "needs-approval") return "needs approval";

  if (source.access === "denied") return "denied";

  return `${source.access === "approved" ? "approved" : "read"} · ${source.writes === "ask" ? "writes ask you" : "read only"}`;
};

export const sourcesView = (
  checkout: string,
  sources: ReadonlyArray<DataSource>,
  known: Known = []
) => {
  const data = sources.map((source) => {
    const item: Omit<DataSource, "id" | "user" | "label"> = {
      name: source.name,
      engine: source.engine,
      locality: source.locality,
      host: source.host,
      port: source.port,
      database: source.database,
      foundIn: source.foundIn,
      access: source.access,
      writes: source.writes,
      reachable: source.reachable,
    };

    return Object.assign(
      item,
      source.version === undefined ? undefined : { version: source.version },
      source.branch === undefined ? undefined : { branch: source.branch },
      source.error === undefined ? undefined : { error: source.error }
    );
  });

  const lines = aligned(
    sources.map((source) => [
      source.name,
      `${source.engine}${source.version === undefined ? "" : ` ${source.version}`}`,
      source.locality,
      source.branch === undefined
        ? `${source.host}:${source.port}/${source.database}`
        : `(${source.branch.provider === "planetscale" ? "PlanetScale" : "Neon"} branch ${source.branch.name})`,
      foundIn(source),
      access(source),
    ])
  );

  return {
    lines: [
      `${sources.length} data sources in ${safeDataText(checkout, known)}`,
      ...lines.map((line) => safeDataText(line, known)),
    ],
    data: { sources: dataValue(data, "", known) },
  };
};

const estimate = (count: number | null) =>
  count === null ? "unknown rows" : `~${count.toLocaleString("en-US")} rows`;

const tableLines = (table: TableDetail, known: Known) => {
  const columns = aligned(
    table.columns.map((column) => [
      column.name,
      column.type,
      column.nullable ? "null" : "not null",
      [
        column.pk ? "pk" : "",
        column.fk === null ? "" : `→ ${column.fk.schema}.${column.fk.table}.${column.fk.column}`,
        column.default === null ? "" : `default ${column.default}`,
      ]
        .filter(Boolean)
        .join("  "),
    ])
  );

  return [
    `${table.schema}.${table.name}  ${estimate(table.rowEstimate)}`,
    ...columns.map((line) => `  ${line}`),
    ...(table.indexes.length === 0
      ? []
      : [
          `indexes: ${table.indexes.map((index) => `${index.name} (${index.columns.join(", ")})`).join(", ")}`,
        ]),
    ...table.constraints.map(
      (constraint) => `${constraint.kind}: ${constraint.name} ${constraint.definition}`
    ),
    ...(table.sample === undefined ? [] : queryView(table.sample, known).text.split("\n")),
  ];
};

export const describeView = (value: SchemaTree | TableDetail, known: Known = []) => {
  if (!(value instanceof SchemaTree)) {
    const detail = {
      schema: value.schema,
      name: value.name,
      columns: value.columns,
      indexes: value.indexes,
      constraints: value.constraints,
      rowEstimate: value.rowEstimate,
    };

    return {
      lines: tableLines(value, known).map((line) => safeDataText(line, known)),
      data: dataObject(
        Object.assign(
          detail,
          value.sample === undefined ? undefined : { sample: queryView(value.sample, known).data }
        ),
        known
      ),
    };
  }

  let remaining = 500;
  let dropped = value.truncatedTables;

  const schemas = value.schemas.map((schema) => {
    const tables = schema.tables.slice(0, remaining);
    remaining -= tables.length;
    dropped += schema.tables.length - tables.length;

    return { ...schema, tables };
  });

  const lines = schemas.flatMap((schema) => [
    schema.name,
    ...schema.tables.map(
      (table) => `  ${table.name}  ${estimate(table.rowEstimate)}  ${table.columnCount} columns`
    ),
    ...schema.views.map(
      (view) => `  view ${view.name}  ${estimate(view.rowEstimate)}  ${view.columnCount} columns`
    ),
    ...schema.functions.map((name) => `  function ${name}`),
  ]);

  if (dropped > 0) lines.push(`${dropped} more tables; describe a table by name`);

  return {
    lines: lines.map((line) => safeDataText(line, known)),
    data: dataObject({ schemas, truncatedTables: dropped }, known),
  };
};

export const cappedLines = (lines: ReadonlyArray<string>) => {
  const full = lines.join("\n");

  if (full.length <= DATA_TEXT_LIMIT) return full;
  let kept = lines.length;

  const suffix = () =>
    `${lines.length - kept} lines omitted; describe a table by name or narrow the query`;

  while (kept > 0 && `${lines.slice(0, kept).join("\n")}\n${suffix()}`.length > DATA_TEXT_LIMIT)
    kept--;

  return `${lines.slice(0, kept).join("\n")}\n${suffix()}`;
};
