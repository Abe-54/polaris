import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { Redacted } from "effect";
import { discover, prisma } from "./discovery.ts";
import { read } from "./read.ts";
import { metadata, parseConnection, connectionUrl } from "./connection.ts";
import { knownFromConnection, scrubKnown } from "./knownCredentials.ts";

const roots: string[] = [];

const fixture = async () => {
  const root = await mkdtemp("/tmp/data-hostile-");
  roots.push(root);

  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const candidate = (url: string) => ({
  name: "app",
  url: Redacted.make(url),
  foundIn: { kind: "env" as const },
});

test("R2: examples never override development; production, staging and test keep separate names", async () => {
  const root = await fixture();

  const files = {
    ".env": "base",
    ".env.local": "local",
    ".env.development": "development",
    ".env.development.local": "override",
    ".env.example": "example",
    ".env.sample": "sample",
    ".env.template": "template",
    ".env.vault": "vault",
    ".env.keys": "keys",
    ".env.production": "production",
    ".env.staging": "staging",
    ".env.test": "test",
  };

  for (const [file, database] of Object.entries(files))
    await writeFile(join(root, file), `DATABASE_URL=postgres://u:p@db.test/${database}`);
  const found = (await discover(root)).map((item) => metadata(root, item));
  expect(found.map((source) => [source?.name, source?.database])).toEqual([
    ["app", "override"],
    ["app (production)", "production"],
    ["app (staging)", "staging"],
    ["app (test)", "test"],
  ]);
  await rm(join(root, ".env.development.local"));
  expect(metadata(root, (await discover(root))[0]!)?.database).toBe("development");
});

test("R2: quoted comments work and unresolved shell variables never become sources", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".env"),
    `DATABASE_URL="postgres://u:p@db.test/quoted" # dev db
DIRECT_URL='postgres://u:p@db.test/single' # another
MYSQL_URL=mysql://$USER:$PASS@$HOST/$NAME
EXPAND_DATABASE_URL=postgres://\u0024{USER}:\u0024{PASS}@\u0024{HOST}/\u0024{NAME}
`
  );
  expect((await discover(root)).map((item) => metadata(root, item)?.database)).toEqual([
    "quoted",
    "single",
  ]);
});

test("R3: devices, FIFOs and oversized regular files cannot enter discovery", async () => {
  const root = await fixture();
  await symlink("/dev/zero", join(root, "compose.yaml"));
  const fifo = Bun.spawn(["/usr/bin/mkfifo", join(root, "compose.yml")]);
  expect(await fifo.exited).toBe(0);
  const huge = await open(join(root, ".env"), "w");
  await huge.truncate(2 * 1024 ** 3);
  await huge.close();
  const started = performance.now();
  expect(await discover(root)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1000);
  await writeFile(
    join(root, ".env.local"),
    `DATABASE_URL=postgres://u:p@db.test/too_big\n${"#".repeat(65536)}`
  );
  expect(await read(root, ".env.local")).toBe("");
  await writeFile(join(root, ".env.local"), "DATABASE_URL=postgres://u:p@db.test/small");
  expect((await discover(root)).map((item) => metadata(root, item)?.database)).toEqual(["small"]);
});

test("R2/F7: config and prisma directory symlinks cannot read another checkout", async () => {
  const root = await fixture();
  const outside = await fixture();
  await mkdir(join(outside, "config"));
  await mkdir(join(outside, "prisma"));
  await writeFile(
    join(outside, "config/database.yml"),
    "development:\n  adapter: postgresql\n  database: private\n"
  );
  await writeFile(
    join(outside, "prisma/schema.prisma"),
    'datasource db { url = "postgres://u:p@db.test/private" }'
  );
  await symlink(join(outside, "config"), join(root, "config"));
  await symlink(join(outside, "prisma"), join(root, "prisma"));
  expect(await discover(root)).toEqual([]);
  expect(
    await read(await realpath(root), "../" + outside.split("/").at(-1) + "/config/database.yml")
  ).toBe("");
});

test("F8: an unterminated Prisma block is scanned once; datasource names survive generator blocks", () => {
  const started = performance.now();
  expect(prisma("datasource x {".repeat(50000), "schema.prisma", {})).toEqual([]);
  expect(performance.now() - started).toBeLessThan(1000);

  const found = prisma(
    'generator client { provider = "prisma-client-js" }\ndatasource primary { url = "postgres://u:p@db.test/app" }',
    "schema.prisma",
    {}
  );

  expect(found.map((item) => item.name)).toEqual(["primary"]);
});

test.each([
  "postgres://app:9876/hunter2@db.example.com:5432/app",
  "postgres://u:p@localhost/postgres%3A%2F%2Fu%3Ahunter2%40prod",
  "postgres://u:p@localhost/db?dbname=contains%40secret",
  "postgres://u:p@localhost/db?user=contains%3Asecret",
  "postgres://u:p@localhost/db?host=contains%40secret",
  "postgres://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}",
])("R1/F5: malformed credential-like target is rejected: %s", (url) => {
  expect(parseConnection(candidate(url))).toBeUndefined();
  expect(metadata("/checkout", candidate(url))).toBeUndefined();
});

test("F5: the selected query password is scrubbed even without URL userinfo", () => {
  const item = candidate("postgres://u@db.test/db?password=query-secret");
  const parsed = parseConnection(item)!;
  expect(Redacted.value(parsed.connection.password)).toBe("query-secret");
  expect(
    scrubKnown("failure: query-secret", knownFromConnection(parsed.connection, item.url))
  ).toBe("failure: [redacted]");
});

test.each(["postgres", "mysql"])("R5: manual %s sockets are the explicit driver path", (engine) => {
  const item = {
    ...candidate(""),
    url: connectionUrl(
      { engine, host: "/tmp/database.sock", port: 5432, database: "app", user: "u" },
      "private"
    ),
  };

  const parsed = parseConnection(item)!;

  if (engine === "mysql") expect(parsed.connection.path).toBe("/tmp/database.sock");
  else expect(parsed.connection.hostname).toBe("/tmp/database.sock");
  expect(metadata("/checkout", item)?.host).toBe("/tmp/database.sock");
});
