/** Text-first Data output; the JSON view uses the same sanitized, clipped values. */
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { Array as Arrays, Match, Schema, Predicate, Redacted } from "effect";
import {
  DataValueTags,
  scrubCredentials,
  scrubDataValue,
  SchemaTree,
  TableSummary,
  type DataSource,
  type QueryResult,
  type TableDetail,
} from "@polaris/protocol";

export const DATA_TEXT_LIMIT = 16_000;

const sensitive = /^(password|passwd|secret|token|api_key)$/i;

type Known = ReadonlyArray<Redacted.Redacted<string>>;

const boundedText = (value: string, known: Known) => {
  let end = 32_000;

  for (const credential of known) {
    const secret = Redacted.value(credential);

    if (secret.length < 4) continue;
    const start = value.indexOf(secret, Math.max(0, end - secret.length + 1));

    if (start >= 0 && start < end && start + secret.length > end) end = start;
  }

  return value.slice(0, end) + (end < Math.min(value.length, 32_000) ? "[redacted]" : "");
};

/** Bound work before generic scanning; the rendering window is smaller than this guard. */
export const safeDataText = (value: string, known: Known = []): string =>
  stripVTControlCharacters(scrubCredentials(boundedText(value, known), known))
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\p{Cc}/gu, "");

const clip = (value: string) =>
  value.length > 200 ? `${value.slice(0, 200)}…(+${value.length - 200} chars)` : value;

type DataCell = Schema.Json;

export const dataValue = (
  value: DataCell,
  key = "",
  known: Known = []
): typeof Schema.Json.Type => {
  if (sensitive.test(key)) return "[redacted]";

  if (value === null || value === undefined) return null;

  if (Schema.is(DataValueTags)(value))
    return Match.value(Schema.decodeUnknownSync(DataValueTags)(scrubDataValue(value, known))).pipe(
      Match.tag("Bytes", (v) => `<bytes ${v.length}>`),
      Match.tag("BigInt", "Numeric", (v) => clip(safeDataText(v.value, known))),
      Match.tag("Timestamp", (v) => clip(safeDataText(v.iso, known))),
      Match.tag("Truncated", (v) => clip(safeDataText(v.preview, known))),
      Match.tag("Json", (v) =>
        clip(
          safeDataText(v.text, known).replace(
            /("(?:\\.|[^"\\])*")(\s*:\s*)("(?:\\.|[^"\\])*")/g,
            (entry, key: string, separator: string) =>
              sensitive.test(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(key))
                ? `${key}${separator}"[redacted]"`
                : entry
          )
        )
      ),
      Match.exhaustive
    );

  if (Predicate.isString(value)) return clip(safeDataText(value, known));

  if (Arrays.isArray<Schema.Json>(value)) return value.map((item) => dataValue(item, "", known));

  if (Predicate.isNumber(value) || Predicate.isBoolean(value)) {
    const safe = safeDataText(String(value), known);

    return safe === String(value) ? value : safe;
  }

  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [clip(safeDataText(k, known)), dataValue(v, k, known)])
  );
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

const countRows = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "row" : "rows"}`;

export const queryView = (result: QueryResult, known: Known = []) => {
  const columns = result.columns.map(({ name, type }) => ({
    name: clip(safeDataText(name, known)),
    type: clip(safeDataText(type, known)),
  }));

  const rows = result.rows.map((row) =>
    row.map((value, i) => dataValue(value, result.columns[i]?.name, known))
  );

  const queryId = clip(safeDataText(result.queryId, known));
  const header = `${countRows(result.returned)} · ${result.elapsedMs} ms · query ${queryId}`;
  let kept = rows.length;
  let keptColumns = columns.length;

  const view = () => {
    const widthDrop = kept < rows.length || keptColumns < columns.length;
    const hint = widthDrop ? "select fewer columns" : "increase the limit or use an aggregate";

    const shown =
      result.total === undefined
        ? `${countRows(kept)} shown`
        : `${kept} of ${countRows(result.total)}`;

    const summary = [header, ...(widthDrop || result.truncated ? [`${shown}; ${hint}`] : [])].join(
      "\n"
    );

    const keptRows = rows.slice(0, kept).map((row) => row.slice(0, keptColumns));
    const keptHeaders = columns.slice(0, keptColumns);

    const rendered = aligned([
      keptHeaders.map((column) => `${column.name} (${column.type})`),
      ...keptRows.map((row) => row.map(cell)),
    ]);

    return {
      text: [header, ...rendered, ...summary.split("\n").slice(1)].join("\n"),
      data: {
        summary,
        queryId,
        columns: keptHeaders,
        rows: keptRows,
        rowCount: kept,
        returned: kept,
        ...(result.total === undefined ? undefined : { total: result.total }),
        truncated: result.truncated || widthDrop,
        elapsedMs: result.elapsedMs,
      },
    };
  };

  let output = view();

  while (
    output.text.length > DATA_TEXT_LIMIT ||
    JSON.stringify(output.data).length > DATA_TEXT_LIMIT
  ) {
    if (kept > 0) kept--;
    else if (keptColumns > 0) keptColumns--;
    else break;
    output = view();
  }

  return output;
};

const foundIn = (source: DataSource) =>
  source.foundIn.kind === "manual"
    ? "added by you"
    : `from ${source.foundIn.file ?? source.foundIn.kind}${source.foundIn.key === undefined ? "" : ` (${source.foundIn.key})`}`;

const access = (source: DataSource) => {
  if (source.engine === "sqlite")
    return source.locality === "local" ? "read · read only" : "outside the checkout, denied";

  if (source.access === "needs-approval") return "needs approval";

  if (source.access === "denied") return "denied";

  return `${source.access === "approved" ? "approved" : "read"} · ${source.writes === "ask" ? "writes ask you" : "read only"}`;
};

const checkoutLabel = (checkout: string) => {
  const normalize = (value: string) =>
    process.platform === "win32" ? value.replaceAll("\\", "/") : value;

  const home = normalize(homedir());
  const path = normalize(checkout);

  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  return comparable(path) === comparable(home) ||
    comparable(path).startsWith(`${comparable(home)}/`)
    ? `~${path.slice(home.length)}`
    : checkout;
};

export const sourcesView = (
  checkout: string,
  sources: ReadonlyArray<DataSource>,
  known: Known = []
) => {
  const data = sources.map((source) => {
    // A SQLite source's server fields are placeholders; agents get its file instead.
    const target =
      source.engine === "sqlite"
        ? { path: source.path ?? "" }
        : { host: source.host, port: source.port, database: source.database };

    const item = {
      name: source.name,
      engine: source.engine,
      locality: source.locality,
      ...target,
      foundIn: source.foundIn,
      access: source.access,
      writes: source.writes,
    };

    if (source.reachable !== undefined) Object.assign(item, { reachable: source.reachable });

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
      source.engine === "sqlite"
        ? (source.path ?? "")
        : source.branch === undefined
          ? `${source.host}:${source.port}/${source.database}`
          : `(${source.branch.provider === "planetscale" ? "PlanetScale" : "Neon"} branch ${source.branch.name})`,
      foundIn(source),
      access(source),
    ])
  );

  return {
    lines: [
      `${sources.length} data ${sources.length === 1 ? "source" : "sources"} in ${safeDataText(checkoutLabel(checkout), known)}`,
      ...lines.map((line) => safeDataText(line, known)),
    ],
    data: { sources: dataValue(Schema.decodeUnknownSync(Schema.Json)(data), "", known) },
  };
};

const estimate = (count: number | null) =>
  count === null ? "unknown rows" : `~${countRows(count)}`;

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
        Schema.decodeUnknownSync(Schema.Json)(
          Object.assign(
            detail,
            value.sample === undefined ? undefined : { sample: queryView(value.sample, known).data }
          )
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

    return {
      ...schema,
      tables: tables.map((table) => Schema.encodeSync(TableSummary)(table)),
      views: schema.views.map((view) => Schema.encodeSync(TableSummary)(view)),
    };
  });

  const lines = schemas.flatMap((schema) => [
    schema.name,
    ...schema.tables.map(
      (table) =>
        `  ${table.name}  ${estimate(table.rowEstimate)}  ${table.columnCount} ${table.columnCount === 1 ? "column" : "columns"}`
    ),
    ...schema.views.map(
      (view) =>
        `  view ${view.name}  ${estimate(view.rowEstimate)}  ${view.columnCount} ${view.columnCount === 1 ? "column" : "columns"}`
    ),
    ...schema.functions.map((name) => `  function ${name}`),
  ]);

  if (dropped > 0)
    lines.push(`${dropped} more ${dropped === 1 ? "table" : "tables"}; describe a table by name`);

  return {
    lines: lines.map((line) => safeDataText(line, known)),
    data: dataObject(
      Schema.decodeUnknownSync(Schema.Json)({ schemas, truncatedTables: dropped }),
      known
    ),
  };
};

export const cappedLines = (lines: ReadonlyArray<string>) => {
  const full = lines.join("\n");

  if (full.length <= DATA_TEXT_LIMIT) return full;
  let kept = lines.length;

  const suffix = () =>
    `${lines.length - kept} ${lines.length - kept === 1 ? "line" : "lines"} omitted; describe a table by name or narrow the query`;

  while (kept > 0 && `${lines.slice(0, kept).join("\n")}\n${suffix()}`.length > DATA_TEXT_LIMIT)
    kept--;

  return `${lines.slice(0, kept).join("\n")}\n${suffix()}`;
};
