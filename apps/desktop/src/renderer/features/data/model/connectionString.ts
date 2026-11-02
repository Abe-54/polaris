/**
 * A pasted connection string read into the Add data source form's fields. It follows the Daemon's
 * `parseConnection` (apps/daemon/src/data/connection.ts): libpq's query overrides and defaults.
 */
import type { DataTls, ServerDataEngine } from "@polaris/protocol";

export type PastedConnection =
  | { readonly engine: "sqlite"; readonly path: string }
  | {
      readonly engine: ServerDataEngine;
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string;
      /** Absent when the string names no TLS mode or turns TLS off. */
      readonly tls?: DataTls;
    };

const SERVER_SCHEMES = new Map<string, ServerDataEngine>([
  ["postgres:", "postgres"],
  ["postgresql:", "postgres"],
  ["mysql:", "mysql"],
]);

const DEFAULTS: Record<ServerDataEngine, { port: number; user: string }> = {
  postgres: { port: 5432, user: "postgres" },
  mysql: { port: 3306, user: "root" },
};

/** A `file:`/`sqlite:` URL to an absolute path; a relative one has no checkout to resolve against. */
const sqlitePath = (text: string): string | undefined => {
  const match = /^(?:file|sqlite3?):(.*)$/is.exec(text);

  if (!match) return undefined;
  let path = match[1]?.split(/[?#]/)[0] ?? "";

  if (path.startsWith("//localhost/")) path = path.slice("//localhost".length);
  else if (path.startsWith("//")) path = path.slice(2);
  path = decodeURIComponent(path);

  // `file:///C:/dev.db` names a Windows drive path.
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);

  if (/[\0\r\n]/.test(path)) return undefined;

  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) ? path : undefined;
};

/** libpq's `sslmode`, MySQL's `ssl-mode` (REQUIRED, VERIFY_IDENTITY…) and `ssl=true`, as one mode. */
const TLS_MODES = new Map<string, DataTls | null>([
  ["true", "require"],
  ["1", "require"],
  ["false", null],
  ["0", null],
  ["disable", null],
  ["disabled", null],
  ["allow", "allow"],
  ["prefer", "prefer"],
  ["preferred", "prefer"],
  ["require", "require"],
  ["required", "require"],
  ["verify-ca", "verify-ca"],
  ["verify_ca", "verify-ca"],
  ["verify-full", "verify-full"],
  ["verify_identity", "verify-full"],
]);

/** The pasted TLS mode: null for off, undefined when the string names one the form can't keep. */
const tlsOf = (value: string | undefined): DataTls | null | undefined =>
  value === undefined ? null : TLS_MODES.get(value.toLowerCase());

/** One query value; a repeated key is ambiguous, as the Daemon rules. */
const queryOf = (url: URL) => (key: string) => {
  const values = url.searchParams.getAll(key);

  if (values.length > 1) throw new Error("Ambiguous connection string");

  return values[0] || undefined;
};

const serverConnection = (url: URL, engine: ServerDataEngine): PastedConnection | undefined => {
  const query = queryOf(url);
  const pg = (key: string) => (engine === "postgres" ? query(key) : undefined);

  const host =
    pg("host") || decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "") || "localhost";

  const port = Number(pg("port") || url.port || DEFAULTS[engine].port);

  if (!Number.isInteger(port) || port < 1 || port > 65_535 || host.includes(",")) return undefined;
  const user = pg("user") || decodeURIComponent(url.username) || DEFAULTS[engine].user;
  const fallbackDatabase = engine === "postgres" ? user : "mysql";
  const database = pg("dbname") || decodeURIComponent(url.pathname.slice(1)) || fallbackDatabase;
  const password = pg("password") || decodeURIComponent(url.password);
  const tls = tlsOf(query("sslmode") || query("ssl-mode") || query("tls") || query("ssl"));

  if (tls === undefined) return undefined;

  return tls === null
    ? { engine, host, port, database, user, password }
    : { engine, host, port, database, user, password, tls };
};

/** The fields a pasted connection string names, or undefined when it isn't one. */
export const parseConnectionString = (pasted: string): PastedConnection | undefined => {
  const text = pasted.trim();

  if (text === "" || /[\r\n]/.test(text)) return undefined;

  try {
    const path = sqlitePath(text);

    if (path !== undefined) return { engine: "sqlite", path };
    const url = new URL(text);
    const engine = SERVER_SCHEMES.get(url.protocol);

    return engine === undefined ? undefined : serverConnection(url, engine);
  } catch {
    return undefined;
  }
};
