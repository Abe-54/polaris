import { Option, Redacted, Schema } from "effect";
import { connectionUrl, type Candidate } from "./connection.ts";

const Scalar = Schema.Union([Schema.String, Schema.Number]);

const EnvironmentList = Schema.Array(Schema.String);

const LongPort = Schema.Struct({ target: Scalar, published: Scalar });

const isEnvironmentList = Schema.is(EnvironmentList);

const isLongPort = Schema.is(LongPort);

const Compose = Schema.Struct({
  services: Schema.Record(
    Schema.String,
    Schema.Struct({
      image: Schema.optionalKey(Schema.String),
      environment: Schema.optionalKey(
        Schema.Union([
          Schema.Record(Schema.String, Schema.NullOr(Scalar)),
          Schema.Array(Schema.String),
        ])
      ),
      ports: Schema.optionalKey(
        Schema.Array(Schema.Union([Scalar, Schema.Struct({ target: Scalar, published: Scalar })]))
      ),
    })
  ),
});

const decodeCompose = Schema.decodeUnknownOption(Compose);

type Service = (typeof Compose.Type.services)[string];

type Environment = Record<string, string>;

const parseCompose = (text: string) => {
  try {
    return Option.getOrUndefined(decodeCompose(Bun.YAML.parse(text)));
  } catch {
    return undefined;
  }
};

const interpolate = (text: string, env: Environment) =>
  text.replace(
    /\$\{([\w]+)(?:(:-|-)([^}]*))?\}/g,
    (_, key: string, operator: string | undefined, fallback: string | undefined) => {
      const value = env[key];

      if (operator === ":-") return value || fallback || "";

      return value ?? fallback ?? "";
    }
  );

const environment = (value: Service["environment"], env: Environment) => {
  const values: Environment = {};

  if (value === undefined) return values;

  if (!isEnvironmentList(value)) {
    for (const [key, entry] of Object.entries(value))
      values[key] = interpolate(String(entry ?? env[key] ?? ""), env);

    return values;
  }

  for (const entry of value) {
    const index = entry.indexOf("=");

    if (index < 0) values[entry] = env[entry] ?? "";
    else values[entry.slice(0, index)] = interpolate(entry.slice(index + 1), env);
  }

  return values;
};

const publishedPort = (ports: Service["ports"], target: number, env: Environment) => {
  for (const entry of ports ?? []) {
    if (isLongPort(entry)) {
      if (Number(entry.target) === target && Number(entry.published) > 0)
        return Number(entry.published);
      continue;
    }

    const parts = interpolate(String(entry), env)
      .replace(/\/tcp$/, "")
      .split(":");

    if (parts.length >= 2 && Number(parts.at(-1)) === target) {
      const port = Number(parts.at(-2));

      if (port > 0 && port <= 65535) return port;
    }
  }

  return undefined;
};

const composeSource = (
  name: string,
  service: Service,
  file: string,
  env: Environment
): Candidate | undefined => {
  const image = service.image ?? "";

  if (!/(?:^|\/)(?:postgres|mysql|mariadb)(?::|$)/.test(image)) return undefined;
  const engine = /(?:^|\/)postgres(?::|$)/.test(image) ? "postgres" : "mysql";
  const port = publishedPort(service.ports, engine === "postgres" ? 5432 : 3306, env);

  if (!port) return undefined;
  const values = environment(service.environment, env);

  const user =
    engine === "postgres" ? values.POSTGRES_USER || "postgres" : values.MYSQL_USER || "root";

  const database = engine === "postgres" ? values.POSTGRES_DB || user : values.MYSQL_DATABASE;

  if (!database) return undefined;

  const password =
    engine === "postgres"
      ? values.POSTGRES_PASSWORD
      : values.MYSQL_PASSWORD || values.MYSQL_ROOT_PASSWORD;

  return {
    name: name.toLowerCase(),
    url: connectionUrl({ engine, host: "localhost", port, database, user }, password ?? ""),
    foundIn: { kind: "compose", file, key: name },
  };
};

export const composeSources = (text: string, file: string, env: Environment): Candidate[] => {
  const config = parseCompose(text);

  if (!config) return [];

  return Object.entries(config.services).flatMap(([name, service]) => {
    const candidate = composeSource(name, service, file, env);

    return candidate ? [candidate] : [];
  });
};

/** Host-side Queries use a compose service's published port, not its container DNS name. */
export const throughCompose = (
  candidate: Candidate,
  services: ReadonlyArray<Candidate>
): Candidate => {
  try {
    const url = new URL(Redacted.value(candidate.url));
    const service = services.find((item) => item.foundIn.key === url.hostname);

    if (!service || ["host", "path", "socket"].some((key) => url.searchParams.has(key)))
      return candidate;
    const published = new URL(Redacted.value(service.url));

    if ((published.protocol === "mysql:") !== (url.protocol === "mysql:")) return candidate;
    url.hostname = "localhost";
    url.port = published.port;

    return { ...candidate, url: Redacted.make(url.href) };
  } catch {
    return candidate;
  }
};
