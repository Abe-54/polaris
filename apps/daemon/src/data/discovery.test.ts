import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Redacted } from "effect";
import { discover } from "./discovery.ts";
import { metadata } from "./connection.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const fixture = async (files: Record<string, string>) => {
  const root = await mkdtemp("/tmp/data-discovery-");
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([file, text]) => {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    })
  );

  return root;
};

const inspect = async (root: string) =>
  (await discover(root)).flatMap((item) => {
    const source = metadata(root, item);

    return source ? [source] : [];
  });

test("environment precedence, names and malformed lines; never exposes a URL or password", async () => {
  const root = await fixture({
    ".env": `DATABASE_URL=postgres://u:old@remote.test/db
POSTGRES_URL_NON_POOLING=postgres://u:p@[::1]/ipv6
MYSQL_URL=mysql://u:p@127.1.2.3/app
SOCKET_DATABASE_URL=postgres://u:p@remote.test/db?host=%2Ftmp%2Fpostgres
malformed DATABASE_URL=secret
DIRECT_URL='postgres://u:pa@ss@localhost/fresh'
`,
    ".env.local": "DATABASE_URL=postgres://u:private@localhost/local\n",
    ".env.development.local": "DATABASE_URL=postgres://u:override@localhost/dev\n",
  });

  const sources = await inspect(root);
  expect(sources.map((s) => [s.name, s.database, s.locality])).toEqual([
    ["app", "dev", "remote"],
    ["postgres_url_non_pooling", "ipv6", "remote"],
    ["mysql_url", "app", "remote"],
    ["socket_database_url", "db", "remote"],
    ["direct_url", "fresh", "remote"],
  ]);
  expect(JSON.stringify(sources)).not.toMatch(/postgres:\/\/|mysql:\/\/|pa@ss|private|override/);
  expect(
    Redacted.value((await discover(root)).find((s) => s.name === "direct_url")!.url)
  ).toContain("pa@ss");
  await writeFile(
    join(root, ".env.development.local"),
    "DATABASE_URL=postgres://u:next@other.test/changed"
  );
  expect((await inspect(root))[0]?.database).toBe("changed");
});

test.each([
  [
    "Prisma",
    {
      ".env": "CUSTOM_URL=postgres://u:pw@localhost/prisma",
      "prisma/schema.prisma":
        'datasource db { provider = "postgresql"\n url = env("CUSTOM_URL")\n}',
    },
    "custom_url",
    "prisma",
  ],
  [
    "Prisma literal",
    {
      "schema.prisma":
        'datasource app { provider = "mysql"\n url = "mysql://u:pw@db.test/literal"\n}',
    },
    "app",
    "literal",
  ],
  [
    "Drizzle URL",
    {
      "drizzle.config.ts":
        'export default defineConfig({ dbCredentials: { url: "postgres://u:p@localhost/drizzle" } });',
    },
    "drizzle",
    "drizzle",
  ],
  [
    "Drizzle env",
    {
      ".env": "SPECIAL_URL=mysql://u:pw@localhost/envdb",
      "drizzle.config.ts":
        "export default defineConfig({ dbCredentials: { url: process.env.SPECIAL_URL! } });",
    },
    "special_url",
    "envdb",
  ],
  [
    "Drizzle fields",
    {
      "drizzle.config.ts":
        'export default defineConfig({dialect:"mysql",dbCredentials:{host:"localhost",port:3307,user:"u",password:"pw",database:"fields"}});',
    },
    "drizzle",
    "fields",
  ],
  [
    "Rails",
    {
      "config/database.yml":
        'default: &default\n  adapter: postgresql\n  host: localhost\n  username: u\n  password: "pa ss"\ndevelopment:\n  <<: *default\n  database: rails\n',
    },
    "rails",
    "rails",
  ],
  [
    "Django",
    {
      "project/settings.py":
        'DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": "django", "USER": "u", "PASSWORD": "pw", "HOST": "localhost", "PORT": "5432"}}',
    },
    "default",
    "django",
  ],
] as const)("discovers %s without loading project code", async (_format, files, name, database) => {
  const root = await fixture(files);
  const sources = await inspect(root);
  expect(sources.map((s) => [s.name, s.database])).toContainEqual([name, database]);
  expect(JSON.stringify(sources)).not.toContain("pw");

  if (_format === "Drizzle fields")
    expect(sources[0]).toMatchObject({ engine: "mysql", port: 3307 });
});

test("compose published ports, environment maps/lists and interpolation connect to this Host", async () => {
  const root = await fixture({
    ".env": "PORT=5544\nDB=ledger\n",
    "compose.yaml": `services:
  postgres:
    image: postgres:16
    ports: ["127.0.0.1:\u0024{PORT}:5432"]
    environment:
      POSTGRES_DB: \u0024{DB}
      POSTGRES_PASSWORD: "p a'ss"
  mysql:
    image: mysql:8.4
    ports:
      - target: 3306
        published: 3307
    environment: ["MYSQL_DATABASE=sales", "MYSQL_USER=app", "MYSQL_PASSWORD=pw"]
  hidden:
    image: postgres:16
    expose: [5432]
`,
  });

  expect((await inspect(root)).map((s) => [s.name, s.engine, s.port, s.locality, s.label])).toEqual(
    [
      ["postgres", "postgres", 5544, "remote", { text: "REMOTE", colour: "red" }],
      ["mysql", "mysql", 3307, "remote", { text: "REMOTE", colour: "red" }],
    ]
  );
});

test("branches and remote defaults are metadata only", async () => {
  const root = await fixture({
    ".env": `DATABASE_URL=postgres://u:p@ep-blue-snow-123-pooler.eu.neon.tech/db
MYSQL_URL=mysql://branch-name:p@aws.connect.psdb.cloud/sales
DIRECT_URL=postgres://u:p@db.company.test/production`,
  });

  const list = await inspect(root);
  expect(list.map((s) => [s.branch, s.label, s.access])).toEqual([
    [
      { provider: "neon", name: "ep-blue-snow-123" },
      { text: "BRANCH", colour: "tan" },
      "needs-approval",
    ],
    [
      { provider: "planetscale", name: "branch-name" },
      { text: "BRANCH", colour: "tan" },
      "needs-approval",
    ],
    [undefined, { text: "REMOTE", colour: "red" }, "needs-approval"],
  ]);
});

test("a compose service URL resolves to its published Host port, preserving credentials", async () => {
  const root = await fixture({
    ".env": "DATABASE_URL=postgres://u:p%40ss@db:5432/app",
    "compose.yaml": 'services:\n  db:\n    image: postgres:16\n    ports: ["5543:5432"]\n',
  });

  const candidate = (await discover(root)).find((item) => item.name === "app")!;
  expect(metadata(root, candidate)).toMatchObject({
    host: "localhost",
    port: 5543,
    locality: "remote",
  });
  expect(new URL(Redacted.value(candidate.url)).password).toBe("p%40ss");
});

test("dynamic framework targets are ignored without executing code or guessing local", async () => {
  const root = await fixture({
    "project/settings.py":
      'DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql", "NAME": "db", "HOST": os.environ["HOST"]}}',
    "drizzle.config.ts":
      'throw new Error("must not run"); export default {dbCredentials:{database:"db",host:"localhost" + suffix}};',
  });

  expect(await inspect(root)).toEqual([]);
});

test("socket aliases and PostgreSQL target parameters determine locality and labels", async () => {
  const root = await fixture({
    ".env": `DATABASE_URL=postgres://u:p@localhost/dev?host=remote.test&port=5438&user=reader&dbname=production
DIRECT_URL=postgres://u:p@ep-local.neon.tech/db?path=/tmp/pg-socket
MYSQL_URL=mysql://u:p@remote.test/db?host=localhost`,
  });

  const list = await inspect(root);
  expect(
    list.map((source) => [
      source.host,
      source.port,
      source.user,
      source.database,
      source.locality,
      source.label,
    ])
  ).toEqual([
    ["remote.test", 5438, "reader", "production", "remote", { text: "REMOTE", colour: "red" }],
    ["/tmp/pg-socket", 5432, "u", "db", "remote", { text: "BRANCH", colour: "tan" }],
    ["remote.test", 3306, "u", "db", "remote", { text: "REMOTE", colour: "red" }],
  ]);
});
