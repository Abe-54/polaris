import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Option, Redacted, Schema } from "effect";
import { connectionUrl, metadata, sourceName, type Candidate } from "./connection.ts";
import { blocks, namedBlocks, literalTarget } from "./literals.ts";
import { ENV_FILES, envValues } from "./env.ts";
import { composeSources, throughCompose } from "./formats.ts";
import { isSqliteUrl, sqliteFile } from "./sqlite/files.ts";

import { findPackages } from "./packages.ts";
import { read } from "./read.ts";

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

/** A SQLite candidate's URL becomes an absolute `file:` URL resolved against `base`. */
const fileCandidate = (item: Candidate, base: string): Candidate[] => {
  const url = Redacted.value(item.url);

  if (!isSqliteUrl(url)) return [item];
  const path = sqliteFile(url, base);

  if (path === undefined) return [];

  return [
    {
      ...item,
      url: connectionUrl({ engine: "sqlite", host: "", port: 0, database: "", user: "", path }, ""),
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

/** drizzle-kit takes a bare path or a `file:` URL for SQLite, relative to the checkout. */
const drizzleSqlite = (text: string, file: string, env: Record<string, string>) => {
  const key = /\burl\s*:\s*process\.env(?:\.([\w]+)|\[["']([^"']+)["']\])/.exec(text);
  const envKey = key?.[1] ?? key?.[2];
  const literal = /\burl\s*:\s*["']([^"']+)["']/.exec(text)?.[1];
  const value = envKey ? env[envKey] : literal;

  if (!value) return [];
  const url = isSqliteUrl(value) ? value : `file:${value}`;

  return [candidate(envKey ?? "drizzle", url, file, envKey ?? "url")];
};

const drizzle = (text: string, file: string, env: Record<string, string>) => {
  const dialect = /\bdialect\s*:\s*["']([^"']+)["']/.exec(text)?.[1];

  if (dialect === "sqlite") return drizzleSqlite(text, file, env);

  const credentials = /\bdbCredentials\s*:\s*/.exec(text);

  if (!credentials) return [];
  const body = blocks(text.slice(credentials.index + credentials[0].length))[0];

  if (!body) return [];
  const key = /\burl\s*:\s*process\.env(?:\.([\w]+)|\[["']([^"']+)["']\])/.exec(body);
  const envKey = key?.[1] ?? key?.[2];

  if (envKey && env[envKey]) return [candidate(envKey, env[envKey], file, envKey)];

  const fields = literalTarget(body);

  if (!fields) return [];

  return frameworkObject("drizzle", { ...fields, dialect: dialect ?? "postgres" }, file);
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

const STAGES = ["production", "staging", "test"];

const COMPOSE = ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];

const FRAMEWORK_FILES = [
  "schema.prisma",
  "prisma/schema.prisma",
  "drizzle.config.ts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "config/database.yml",
  "settings.py",
];

/** Every file discovery reads in one directory, `settings.py` one directory deep included. */
export const discoveryFiles = async (checkout: string, dir: string) => {
  const entries = await readdir(join(checkout, dir), { withFileTypes: true }).catch(() => []);

  const settings = entries
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith(".") && !["node_modules", "vendor"].includes(e.name)
    )
    .map((e) => `${e.name}/settings.py`);

  return [
    ...ENV_FILES,
    ...STAGES.map((stage) => `.env.${stage}`),
    ...COMPOSE,
    ...FRAMEWORK_FILES,
    ...settings,
  ].map((file) => at(dir, file));
};

const at = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);

const framework = (file: string, text: string, env: Record<string, string>, base: string) => {
  if (file.endsWith(".prisma"))
    // Prisma resolves a SQLite file: path against the schema's directory, even through env().
    return prisma(text, file, env).flatMap((item) =>
      fileCandidate(item, join(base, dirname(file)))
    );

  if (/(^|\/)drizzle\.config\.[mjt]s$/.test(file)) return drizzle(text, file, env);

  if (file.endsWith(".yml")) return rails(text, file, env);

  return django(text, file);
};

/** One directory's candidates. A package's env files sit over the root's, as its own tools load them. */
const discoverIn = async (
  checkout: string,
  dir: string,
  inherited: Record<string, string>,
  signal?: AbortSignal
) => {
  const env = { ...inherited };
  const own: Record<string, string> = {};
  const origins = new Map<string, string>();

  for (const file of ENV_FILES.map((name) => at(dir, name))) {
    signal?.throwIfAborted();

    for (const [key, value] of Object.entries(envValues(await read(checkout, file)))) {
      env[key] = value;
      own[key] = value;
      origins.set(key, file);
    }
  }

  const found = envCandidates(own, (key) => origins.get(key) ?? at(dir, ".env"));

  for (const environment of STAGES) {
    const file = at(dir, `.env.${environment}`);
    found.push(
      ...envCandidates(envValues(await read(checkout, file)), () => file).map((item) => ({
        ...item,
        name: `${item.name} (${environment})`,
      }))
    );
  }

  const files = (await discoveryFiles(checkout, dir)).filter(
    (file) => !/(^|\/)\.env|compose\.ya?ml$/.test(file)
  );

  for (const file of files) {
    signal?.throwIfAborted();
    const items = framework(file, await read(checkout, file), env, checkout);

    if (file.endsWith(".prisma")) {
      const sqlite = new Set(
        items.filter((item) => isSqliteUrl(Redacted.value(item.url))).map((item) => item.name)
      );

      found.splice(0, found.length, ...found.filter((item) => !sqlite.has(item.name)), ...items);
    } else found.push(...items);
  }

  const composed: Candidate[] = [];

  for (const file of COMPOSE.map((name) => at(dir, name)))
    composed.push(...composeSources(await read(checkout, file), file, env));

  return {
    env,
    composed,
    found: found.flatMap((item) => fileCandidate(item, join(checkout, dir))),
  };
};

/** A package's sources are named after its directory, or its whole path when two share a name. */
const labels = (packages: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();

  for (const dir of packages) counts.set(basename(dir), (counts.get(basename(dir)) ?? 0) + 1);

  return (dir: string) => (counts.get(basename(dir)) === 1 ? basename(dir) : dir);
};

/**
 * Reads only known configuration files, at the root and in each package directory (`findPackages`).
 * No code is loaded. Root names are unchanged; a package's are prefixed with its label.
 */
export const discover = async (
  checkout: string,
  signal?: AbortSignal,
  packages?: ReadonlyArray<string>
): Promise<Candidate[]> => {
  const dirs = packages ?? (await findPackages(checkout, signal));
  const root = await discoverIn(checkout, "", {}, signal);
  const label = labels(dirs);
  const found = root.found;
  const composed = [...root.composed];

  for (const dir of dirs) {
    const nested = await discoverIn(checkout, dir, root.env, signal);
    found.push(...nested.found.map((item) => ({ ...item, name: `${label(dir)}/${item.name}` })));
    composed.push(
      ...nested.composed.map((item) => ({ ...item, name: `${label(dir)}/${item.name}` }))
    );
  }

  const mapped = found.map((item) =>
    isSqliteUrl(Redacted.value(item.url)) ? item : throughCompose(item, composed)
  );

  mapped.push(...composed);
  const names = new Set<string>();
  const targets = new Set<string>();

  return mapped.filter((item) => {
    const target = Redacted.value(item.url);
    const nested = item.name.includes("/");

    if (!metadata(checkout, item) || names.has(item.name) || (nested && targets.has(target)))
      return false;
    names.add(item.name);
    targets.add(target);

    return true;
  });
};

const envCandidates = (env: Record<string, string>, file: (key: string) => string) =>
  Object.entries(env)
    .filter(([key]) =>
      /^(DATABASE_URL|DIRECT_URL|POSTGRES_URL\w*|MYSQL_URL|\w+_DATABASE_URL)$/.test(key)
    )
    .map(([key, url]) => candidate(key, url, file(key), key, "env"));
