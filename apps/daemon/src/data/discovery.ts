import { readdir } from "node:fs/promises";
import { Option, Redacted, Schema } from "effect";
import { connectionUrl, metadata, sourceName, type Candidate } from "./connection.ts";
import { blocks, namedBlocks, literalTarget, unquote } from "./literals.ts";
import { composeSources, throughCompose } from "./formats.ts";

import { read } from "./read.ts";

const envValues = (text: string) => {
  const values: Record<string, string> = {};

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);

    if (match?.[1] && match[2] !== undefined) {
      const value = unquote(match[2]);

      if (!/\$(?:\{|[A-Za-z_])/.test(value)) values[match[1]] = value;
    }
  }

  return values;
};

const candidate = (
  name: string,
  url: string,
  file: string,
  key: string,
  kind: "env" | "framework" = "framework"
): Candidate => ({
  name: sourceName(name),
  url: Redacted.make(url),
  foundIn: { kind, file, key },
});

const frameworkObject = (
  name: string,
  fields: Record<string, string>,
  file: string
): Candidate[] => {
  const direct = fields.url ?? fields.URL;

  if (direct) return [candidate(name, direct, file, name)];
  const engineText = fields.ENGINE ?? fields.adapter ?? fields.dialect ?? "postgres";
  const engine = /mysql/.test(engineText) ? "mysql" : "postgres";

  if (!/postgres|postgis|mysql/.test(engineText)) return [];
  const database = fields.database ?? fields.NAME;

  if (!database) return [];

  return [
    {
      name: sourceName(name),
      url: connectionUrl(
        {
          engine,
          host: fields.host ?? fields.HOST ?? "localhost",
          port: Number(fields.port ?? fields.PORT) || (engine === "mysql" ? 3306 : 5432),
          user: fields.user ?? fields.username ?? fields.USER ?? "",
          database,
        },
        fields.password ?? fields.PASSWORD ?? ""
      ),
      foundIn: { kind: "framework", file, key: name },
    },
  ];
};

export const prisma = (text: string, file: string, env: Record<string, string>) => {
  const found: Candidate[] = [];

  for (const { name, body } of namedBlocks(text, /\bdatasource\s+(\w+)\s*\{/g)) {
    const key = /\burl\s*=\s*env\(["']([^"']+)["']\)/.exec(body)?.[1];
    const literal = /\burl\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    const url = key ? env[key] : literal;

    if (url) found.push(candidate(key ?? name, url, file, key ?? "url"));
  }

  return found;
};

const drizzle = (text: string, file: string, env: Record<string, string>) => {
  const credentials = /\bdbCredentials\s*:\s*/.exec(text);

  if (!credentials) return [];
  const body = blocks(text.slice(credentials.index + credentials[0].length))[0];

  if (!body) return [];
  const key = /\burl\s*:\s*process\.env(?:\.([\w]+)|\[["']([^"']+)["']\])/.exec(body);
  const envKey = key?.[1] ?? key?.[2];

  if (envKey && env[envKey]) return [candidate(envKey, env[envKey], file, envKey)];

  const fields = literalTarget(body);

  if (!fields) return [];
  const dialect = /\bdialect\s*:\s*["']([^"']+)["']/.exec(text)?.[1] ?? "postgres";

  return frameworkObject("drizzle", { ...fields, dialect }, file);
};

const django = (text: string, file: string) => {
  const tail = text.split(/\bDATABASES\s*=/)[1];
  const root = tail ? blocks(tail)[0] : undefined;

  if (!root) return [];
  const found: Candidate[] = [];

  for (const entry of root.matchAll(/["']([^"']+)["']\s*:\s*\{/g)) {
    const body = blocks(root.slice(entry.index + entry[0].length - 1))[0];

    if (!body) continue;
    const fields = literalTarget(body);

    if (fields?.ENGINE) found.push(...frameworkObject(entry[1] ?? "app", fields, file));
  }

  return found;
};

const Rails = Schema.Struct({
  development: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
});

const decodeRails = Schema.decodeUnknownOption(Rails);

const rails = (text: string, file: string, env: Record<string, string>) => {
  const expanded = text.replace(/<%=\s*ENV\[["']([\w]+)["']\]\s*%>/g, (_, key: string) =>
    JSON.stringify(env[key] ?? "")
  );

  if (expanded.includes("<%")) return [];
  let config: typeof Rails.Type | undefined;

  try {
    config = Option.getOrUndefined(decodeRails(Bun.YAML.parse(expanded)));
  } catch {
    return [];
  }

  if (!config) return [];

  const fields = Object.fromEntries(
    Object.entries(config.development).map(([key, value]) => [key, String(value)])
  );

  return frameworkObject("rails", fields, file);
};

/** Reads only known configuration files and one directory level for Django projects. No code is loaded. */
export const discover = async (checkout: string, signal?: AbortSignal): Promise<Candidate[]> => {
  const entries = await readdir(checkout, { withFileTypes: true }).catch(() => []);
  const env: Record<string, string> = {};
  const origins = new Map<string, string>();

  const envFiles = [".env", ".env.local", ".env.development", ".env.development.local"];

  for (const file of envFiles) {
    signal?.throwIfAborted();

    for (const [key, value] of Object.entries(envValues(await read(checkout, file)))) {
      env[key] = value;
      origins.set(key, file);
    }
  }

  const found = envCandidates(env, (key) => origins.get(key) ?? ".env");

  for (const environment of ["production", "staging", "test"]) {
    const file = `.env.${environment}`;
    found.push(
      ...envCandidates(envValues(await read(checkout, file)), () => file).map((item) => ({
        ...item,
        name: `${item.name} (${environment})`,
      }))
    );
  }

  const frameworkFiles = [
    "schema.prisma",
    "prisma/schema.prisma",
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "config/database.yml",
    "settings.py",
    ...entries
      .filter(
        (e) =>
          e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "vendor"].includes(e.name)
      )
      .map((e) => `${e.name}/settings.py`),
  ];

  for (const file of frameworkFiles) {
    signal?.throwIfAborted();
    const text = await read(checkout, file);

    if (file.endsWith(".prisma")) found.push(...prisma(text, file, env));
    else if (file.startsWith("drizzle")) found.push(...drizzle(text, file, env));
    else if (file.endsWith(".yml")) found.push(...rails(text, file, env));
    else found.push(...django(text, file));
  }

  const composed: Candidate[] = [];

  for (const file of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"])
    composed.push(...composeSources(await read(checkout, file), file, env));
  const mapped = found.map((item) => throughCompose(item, composed));
  mapped.push(...composed);
  const names = new Set<string>();

  return mapped.filter((item) => {
    if (!metadata(checkout, item) || names.has(item.name)) return false;
    names.add(item.name);

    return true;
  });
};

const envCandidates = (env: Record<string, string>, file: (key: string) => string) =>
  Object.entries(env)
    .filter(([key]) =>
      /^(DATABASE_URL|DIRECT_URL|POSTGRES_URL\w*|MYSQL_URL|\w+_DATABASE_URL)$/.test(key)
    )
    .map(([key, url]) => candidate(key, url, file(key), key, "env"));
