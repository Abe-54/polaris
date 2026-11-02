import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { metadata } from "./connection.ts";
import { discover } from "./discovery.ts";
import { cachedDiscovery } from "./discoveryCache.ts";
import { PACKAGE_LIMIT, findPackages, packageDirs } from "./packages.ts";
import { tempDir } from "../platform/tempDir.testing.ts";

const fixture = async (files: Record<string, string>, git = false) => {
  const root = tempDir("data-packages-", { short: true });

  for (const [file, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  }

  if (git) Bun.spawnSync(["git", "init", "-q"], { cwd: root });

  return root;
};

const listed = async (root: string) =>
  (await discover(root)).map((item) => {
    const source = metadata(root, item)!;

    return [source.name, source.database, item.foundIn.kind === "manual" ? "" : item.foundIn.file];
  });

test("a monorepo's packages are found through git, with their ignored env files", async () => {
  const root = await fixture(
    {
      ".gitignore": ".env\nnode_modules/\n",
      "package.json": "{}",
      ".env": "DATABASE_URL=postgres://u:p@remote.test/root\n",
      "packages/db/package.json": "{}",
      "packages/db/.env": "DATABASE_URL=postgres://u:p@remote.test/shared\n",
      "packages/db/prisma/schema.prisma":
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
      "apps/web/package.json": "{}",
      "apps/web/.env": "DATABASE_URL=postgres://u:p@remote.test/shared\n",
      "apps/bot/package.json": "{}",
      "apps/bot/.env": "DATABASE_URL=postgres://u:p@remote.test/bot\n",
      "node_modules/dep/package.json": "{}",
      "node_modules/dep/.env": "DATABASE_URL=postgres://u:p@remote.test/dependency\n",
    },
    true
  );

  expect(await listed(root)).toEqual([
    ["app", "root", ".env"],
    ["bot/app", "bot", "apps/bot/.env"],
    ["web/app", "shared", "apps/web/.env"],
  ]);
});

test("a package's framework config reads its env over the root's", async () => {
  const root = await fixture(
    {
      ".env":
        "SHARED_DATABASE_URL=postgres://u:p@remote.test/ignored\nPRISMA_DB=postgres://u:p@remote.test/root\n",
      "packages/db/package.json": "{}",
      "packages/db/prisma/schema.prisma": 'datasource db {\n  url = env("PRISMA_DB")\n}\n',
    },
    true
  );

  expect(await listed(root)).toContainEqual([
    "db/prisma_db",
    "root",
    "packages/db/prisma/schema.prisma",
  ]);
});

test("without git, the walk skips dot and dependency directories; same-named packages keep their paths", async () => {
  const root = await fixture({
    "services/api/package.json": "{}",
    "services/api/.env": "DATABASE_URL=postgres://u:p@remote.test/one\n",
    "tools/api/pyproject.toml": "",
    "tools/api/.env": "DATABASE_URL=postgres://u:p@remote.test/two\n",
    "node_modules/x/package.json": "{}",
    "node_modules/x/.env": "DATABASE_URL=postgres://u:p@remote.test/three\n",
    ".cache/y/package.json": "{}",
    ".cache/y/.env": "DATABASE_URL=postgres://u:p@remote.test/four\n",
  });

  expect(await listed(root)).toEqual([
    ["services/api/app", "one", "services/api/.env"],
    ["tools/api/app", "two", "tools/api/.env"],
  ]);
});

test("package directories stop at the depth limit and keep the shallowest past the count limit", () => {
  const many = Array.from({ length: PACKAGE_LIMIT + 5 }, (_, i) => `a/b/p${i}/package.json`);

  const dirs = packageDirs([
    "deep/a/b/c/d/package.json",
    "x/config/database.yml",
    ...many,
    "z/go.mod",
  ]);

  expect(dirs.slice(0, 2)).toEqual(["x", "z"]);
  expect(dirs).toHaveLength(PACKAGE_LIMIT);
  expect(dirs).not.toContain("deep/a/b/c/d");
});

test("a new package or a changed package env file invalidates cached discovery", async () => {
  const root = await fixture({ "apps/web/package.json": "{}" }, true);
  const cached = cachedDiscovery(discover);

  expect(await cached(root)).toEqual([]);
  await writeFile(join(root, "apps/web/.env"), "DATABASE_URL=postgres://u:p@remote.test/one\n");
  expect((await cached(root)).map((item) => item.name)).toEqual(["web/app"]);
  await mkdir(join(root, "apps/bot"));
  await writeFile(join(root, "apps/bot/package.json"), "{}");
  await writeFile(join(root, "apps/bot/.env"), "DATABASE_URL=postgres://u:p@remote.test/two\n");
  expect((await cached(root)).map((item) => item.name)).toEqual(["bot/app", "web/app"]);
  expect(await findPackages(root)).toEqual(["apps/bot", "apps/web"]);
});
