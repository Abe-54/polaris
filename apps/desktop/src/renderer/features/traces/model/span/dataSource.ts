/**
 * "Open in Data" on a database Span: the checkout's Data Source it talked to, matched by engine,
 * database, port and host from its `db.*` and `server.*` attributes, and the table its query names.
 */
import type { DataSource, TraceAttributes } from "@polaris/protocol";
import { tableRefOf } from "../../../data/model/queryLog.ts";
import { fieldText } from "./fields.ts";

const ENGINES = new Map<string, DataSource["engine"]>([
  ["postgresql", "postgres"],
  ["postgres", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["sqlite", "sqlite"],
]);

const engineOf = (system: string) => ENGINES.get(system.toLowerCase());

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const sameHost = (a: string, b: string) =>
  a.toLowerCase() === b.toLowerCase() || (LOOPBACK.has(a) && LOOPBACK.has(b));

const read = (attributes: TraceAttributes, ...keys: ReadonlyArray<string>) => {
  const value = keys.map((k) => attributes[k]).find((v) => v !== undefined && v !== null);

  return value === undefined ? null : fieldText(value);
};

/** `db.namespace` may carry a schema after a `|` (semantic conventions); the database leads. */
const databaseOf = (namespace: string) => namespace.split("|")[0] ?? namespace;

/**
 * The Data Source a database Span ran against; null for any other Span, or when none or several
 * match. A Span that names no server only matches Local Data Sources, never production.
 */
export const spanDataSource = (
  attributes: TraceAttributes,
  sources: ReadonlyArray<DataSource>
): DataSource | null => {
  const system = read(attributes, "db.system.name", "db.system");
  const engine = system === null ? undefined : engineOf(system);
  const namespace = read(attributes, "db.namespace", "db.name");

  if (engine === undefined || namespace === null) return null;
  const host = read(attributes, "server.address", "net.peer.name");
  const port = read(attributes, "server.port", "net.peer.port");

  // A SQLite Span names its file; a SQLite source's server fields are placeholders.
  const matches = sources.filter((s) =>
    engine === "sqlite"
      ? s.engine === "sqlite" && s.path === namespace
      : s.engine === engine &&
        s.database === databaseOf(namespace) &&
        (port === null || String(s.port) === port) &&
        (host === null ? s.locality === "local" : sameHost(host, s.host))
  );

  return matches.length === 1 ? (matches[0] ?? null) : null;
};

export interface SpanTable {
  readonly schema: string | null;
  readonly name: string;
}

/** The table the Span's query touched: `db.collection.name`, else the one its SQL names. */
export const spanTable = (attributes: TraceAttributes): SpanTable | null => {
  const named = read(attributes, "db.collection.name", "db.sql.table");

  if (named !== null && named !== "") return { schema: null, name: named };
  const sql = read(attributes, "db.query.text", "db.statement");
  const ref = sql === null ? null : tableRefOf(sql);

  return ref === null ? null : { schema: ref.schema ?? null, name: ref.name };
};
