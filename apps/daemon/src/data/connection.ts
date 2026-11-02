import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { DATA_FILE_SERVER, DataSource, type DataSourceLabel } from "@polaris/protocol";
import { Redacted } from "effect";
import { sqliteFile } from "./sqlite/files.ts";

export interface Candidate {
  readonly name: string;
  readonly url: Redacted.Redacted<string>;
  readonly foundIn: DataSource["foundIn"];
}

export interface DataConnection {
  readonly hostname: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: Redacted.Redacted<string>;
  readonly tls: false | "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
  readonly path?: string;
  /** The SQLite database file; the server fields are then `DATA_FILE_SERVER` placeholders. */
  readonly file?: string;
}

/** A SQLite candidate's connection: only `file` is real. */
const fileConnection = (file: string): DataConnection => ({
  hostname: DATA_FILE_SERVER.host,
  port: DATA_FILE_SERVER.port,
  database: DATA_FILE_SERVER.database,
  username: "",
  password: Redacted.make(""),
  tls: false,
  file,
});

const hasControl = (value: string) => Array.from(value).some((char) => char.charCodeAt(0) < 32);

/** Resolve a URL once; X must pass these explicit options, never the URL, to Bun.SQL. */
export const parseConnection = (
  candidate: Candidate
): { engine: DataSource["engine"]; connection: DataConnection } | undefined => {
  try {
    const file = sqliteFile(Redacted.value(candidate.url));

    if (file !== undefined) return { engine: "sqlite", connection: fileConnection(file) };
    const url = new URL(Redacted.value(candidate.url));

    if (!["postgres:", "postgresql:", "mysql:"].includes(url.protocol)) return undefined;
    const engine = url.protocol === "mysql:" ? "mysql" : "postgres";

    const query = (key: string) => {
      const values = url.searchParams.getAll(key);

      if (values.length > 1) throw new Error("Ambiguous data source target");

      return values[0] || undefined;
    };

    const pg = (key: string) => (engine === "postgres" ? query(key) : undefined);

    const hostname =
      pg("host") || decodeURIComponent(url.hostname).replace(/^\[|\]$/g, "") || "localhost";

    const port = Number(pg("port") || url.port || (engine === "postgres" ? 5432 : 3306));

    if (!Number.isInteger(port) || port < 1 || port > 65535 || hostname.includes(","))
      return undefined;

    const username =
      pg("user") ||
      decodeURIComponent(url.username) ||
      (engine === "postgres" ? "postgres" : "root");

    const database =
      pg("dbname") ||
      decodeURIComponent(url.pathname.slice(1)) ||
      (engine === "postgres" ? username : "mysql");

    const password = pg("password") || decodeURIComponent(url.password);
    const tls = tlsMode(query("sslmode") || query("ssl-mode") || query("tls") || query("ssl"));
    const path = query("path") || query("socket");

    const safeName = (value: string) =>
      !/[@/:\\]/.test(value) && !hasControl(value) && !/\$(?:\{|[A-Za-z_])/.test(value);

    const safePath = (value: string) =>
      value.startsWith("/") &&
      !/[@:\\]/.test(value) &&
      !hasControl(value) &&
      !/\$(?:\{|[A-Za-z_])/.test(value);

    const safeHost = safePath(hostname) || isIP(hostname) === 6 || safeName(hostname);

    if (!safeHost || !safeName(username) || !safeName(database)) return undefined;

    if (path && !safePath(path)) return undefined;

    const connection: DataConnection = {
      hostname,
      port,
      database,
      username,
      password: Redacted.make(password),
      tls,
    };

    if (path) return { engine, connection: { ...connection, path } };

    return { engine, connection };
  } catch {
    return undefined;
  }
};

const tlsMode = (value: string | undefined): DataConnection["tls"] => {
  if (!value || value === "false" || value === "0") return false;

  if (value === "true" || value === "1") return "require";

  switch (value) {
    case "disable":
    case "allow":
    case "prefer":
    case "require":
    case "verify-ca":
    case "verify-full":
      return value;
    default:
      throw new Error("Unsupported data source TLS mode");
  }
};

export const sourceId = (checkout: string, name: string) =>
  createHash("sha256").update(`${checkout}\0${name}`).digest("hex");

export const sourceName = (name: string) => (name === "DATABASE_URL" ? "app" : name.toLowerCase());

export const localHost = (host: string) => {
  const plain = host.replace(/^\[|\]$/g, "").toLowerCase();

  return (
    plain === "localhost" ||
    plain === "::1" ||
    plain.startsWith("/") ||
    (isIP(plain) === 4 && plain.startsWith("127."))
  );
};

const branchOf = (host: string, user: string): DataSource["branch"] => {
  if (host.endsWith(".neon.tech")) {
    const endpoint = host.split(".")[0]?.replace(/-pooler$/, "");

    if (endpoint?.startsWith("ep-")) return { provider: "neon", name: endpoint };
  }

  if (host.endsWith(".psdb.cloud")) {
    const prefix = host.split(".")[0];

    return { provider: "planetscale", name: user || prefix || "branch" };
  }

  return undefined;
};

export const defaultLabel = (
  locality: DataSource["locality"],
  branch?: DataSource["branch"]
): DataSourceLabel => {
  if (locality === "local") return { text: branch ? "BRANCH" : "LOCAL", colour: "none" };

  if (branch) return { text: "BRANCH", colour: "tan" };

  return { text: "REMOTE", colour: "red" };
};

/** Only these selected URL fields leave discovery; parser errors never include their input. */
export const metadata = (
  checkout: string,
  candidate: Candidate,
  locality: DataSource["locality"] = "remote"
): DataSource | undefined => {
  try {
    const parsed = parseConnection(candidate);

    if (!parsed) return undefined;
    const { engine, connection } = parsed;

    if (engine === "sqlite" && connection.file !== undefined)
      return new DataSource({
        id: sourceId(checkout, candidate.name),
        name: candidate.name,
        engine,
        ...DATA_FILE_SERVER,
        path: connection.file,
        locality,
        foundIn: candidate.foundIn,
        label: defaultLabel(locality),
        access: locality === "local" ? "read" : "denied",
        writes: "off",
      });
    const host = connection.path || connection.hostname;
    const { database, username: user, port } = connection;
    const branch = branchOf(connection.hostname, user);

    const details = {
      id: sourceId(checkout, candidate.name),
      name: candidate.name,
      engine,
      host,
      port,
      database,
      user,
      locality,
      foundIn: candidate.foundIn,
      label: defaultLabel(locality, branch),
      access: locality === "local" ? "read" : "needs-approval",
      writes: "ask",
    } as const;

    const secured = connection.tls === false ? details : { ...details, tls: connection.tls };

    if (branch) return new DataSource({ ...secured, branch });

    return new DataSource(secured);
  } catch {
    return undefined;
  }
};

export const connectionUrl = (
  input: {
    engine: string;
    host: string;
    port: number;
    database: string;
    user: string;
    path?: string | undefined;
    tls?: DataConnection["tls"] | undefined;
  },
  password: string
) => {
  if (input.engine === "sqlite") {
    if (input.path === undefined) throw new Error("A SQLite source needs its file path");

    return Redacted.make(
      `file:${encodeURI(input.path).replaceAll("?", "%3F").replaceAll("#", "%23")}`
    );
  }

  const host =
    input.host.includes(":") && !input.host.startsWith("[") ? `[${input.host}]` : input.host;

  const server = input.host.startsWith("/") ? "localhost" : host;

  const url = new URL(
    `${input.engine}://${server}:${input.port}/${encodeURIComponent(input.database)}`
  );

  url.username = input.user;
  url.password = password;

  if (input.host.startsWith("/"))
    url.searchParams.set(input.engine === "mysql" ? "socket" : "host", input.host);

  if (input.tls) url.searchParams.set("sslmode", input.tls);

  return Redacted.make(url.href);
};

/** Labels are scoped to the selected driver target, independently of the display name. */
export const targetFingerprint = (
  source: Pick<DataSource, "engine" | "host" | "port" | "database" | "user" | "path">
) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        source.engine === "sqlite"
          ? [source.engine, source.path ?? ""]
          : [source.engine, source.host, source.port, source.database, source.user ?? ""]
      )
    )
    .digest("hex");
