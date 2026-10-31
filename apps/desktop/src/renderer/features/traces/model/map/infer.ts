/**
 * What a client span called when nothing it called sent spans (DESIGN.md, Traces → Service map):
 * a database from `db.system`, a broker from `messaging.system`, an RPC service, or an HTTP host.
 */
import type { TraceAttributes } from "@polaris/protocol";
import { Predicate } from "effect";

export type TargetKind = "database" | "remote";

export interface Target {
  readonly name: string;
  readonly kind: TargetKind;
  /** The connector's protocol word ("SQL", "HTTP", "REDIS"), or null when nothing says. */
  readonly protocol: string | null;
}

/** Systems whose queries are SQL, so their connectors read "SQL" rather than the system's name. */
const SQL_SYSTEMS = new Set([
  "postgresql",
  "mysql",
  "mariadb",
  "sqlite",
  "mssql",
  "microsoft.sql_server",
  "oracle",
  "oracle.db",
  "cockroachdb",
  "clickhouse",
  "duckdb",
  "trino",
]);

/** An attribute's text, trimmed; null when it's missing, empty or not a string. */
export const attributeText = (attributes: TraceAttributes, key: string): string | null => {
  const value = attributes[key];

  return Predicate.isString(value) && value.trim() !== "" ? value.trim() : null;
};

const text = attributeText;

const hostOf = (url: string | null): string | null => {
  if (url === null) return null;

  try {
    const host = new URL(url).hostname;

    return host === "" ? null : host;
  } catch {
    return null;
  }
};

const address = (attributes: TraceAttributes) =>
  text(attributes, "server.address") ??
  text(attributes, "net.peer.name") ??
  hostOf(text(attributes, "url.full") ?? text(attributes, "http.url"));

const isHttp = (attributes: TraceAttributes) =>
  text(attributes, "http.request.method") !== null ||
  text(attributes, "http.method") !== null ||
  text(attributes, "url.full") !== null ||
  text(attributes, "http.url") !== null;

const database = (attributes: TraceAttributes): Target | null => {
  const system = text(attributes, "db.system.name") ?? text(attributes, "db.system");

  if (system === null) return null;

  return {
    name: system,
    kind: "database",
    protocol: SQL_SYSTEMS.has(system) ? "SQL" : system.toUpperCase(),
  };
};

const messaging = (attributes: TraceAttributes): Target | null => {
  const system = text(attributes, "messaging.system");

  if (system === null) return null;

  return {
    name: text(attributes, "messaging.destination.name") ?? system,
    kind: "remote",
    protocol: system.toUpperCase(),
  };
};

const rpc = (attributes: TraceAttributes): Target | null => {
  const system = text(attributes, "rpc.system");
  const name = text(attributes, "rpc.service") ?? address(attributes);

  if (system === null || name === null) return null;

  return { name, kind: "remote", protocol: system.toUpperCase() };
};

/** The dependency a client span names, or null when its attributes don't say. */
export const inferTarget = (attributes: TraceAttributes): Target | null => {
  const named = database(attributes) ?? messaging(attributes) ?? rpc(attributes);

  if (named !== null) return named;
  const host = address(attributes);

  if (host === null) return null;

  return { name: host, kind: "remote", protocol: isHttp(attributes) ? "HTTP" : null };
};

/** The connector's protocol word for a span that called a traced service, from either side. */
export const protocolOf = (attributes: TraceAttributes): string | null => {
  const target = database(attributes) ?? messaging(attributes) ?? rpc(attributes);

  if (target !== null) return target.protocol;

  return isHttp(attributes) || text(attributes, "http.route") !== null ? "HTTP" : null;
};

/**
 * A traced service the host names: the service itself, or the first label of its host name
 * ("fx-rates.internal" is fx-rates) when exactly that service is in the trace.
 */
export const matchService = (name: string, services: ReadonlySet<string>): string | null => {
  if (services.has(name)) return name;
  const label = name.split(".")[0] ?? "";

  return label !== name && services.has(label) ? label : null;
};
