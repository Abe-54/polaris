/** SQLite discovery from env and framework config, manual files and locality, through DataSources. */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_FILE_SERVER, type DataSource } from "@polaris/protocol";
import { Effect } from "effect";
import { DataSources } from "../index.ts";
import { sourcesView } from "../../mcp/tools/dataFormat.ts";
import { seedDatabase, sessionId, sqliteServices, tempDir, write } from "./sqlite.testing.ts";

const label = { text: "", colour: "none" } as const;

const listIn = (checkout: string) =>
  Effect.gen(function* () {
    const sources = yield* DataSources;

    return yield* sources.list({ sessionId });
  }).pipe(Effect.provide(sqliteServices(checkout)));

const files = (list: ReadonlyArray<DataSource>) =>
  Object.fromEntries(list.map((source) => [source.name, [source.engine, source.path]]));

test.each([
  {
    name: "a .env DATABASE_URL file: URL resolves against the checkout",
    files: { ".env": "DATABASE_URL=file:./data/app.db\n" },
    expected: { app: "data/app.db" },
  },
  {
    name: "a sqlite: URL in .env.local",
    files: { ".env.local": 'DATABASE_URL="sqlite:./local.sqlite"\n' },
    expected: { app: "local.sqlite" },
  },
  {
    name: "Prisma's sqlite provider resolves env() against the schema's directory",
    files: {
      ".env": 'DATABASE_URL="file:./dev.db"\n',
      "prisma/schema.prisma":
        'datasource db {\n  provider = "sqlite"\n  url      = env("DATABASE_URL")\n}\n',
    },
    expected: { app: "prisma/dev.db" },
  },
  {
    name: "Prisma's literal file: URL",
    files: {
      "schema.prisma": 'datasource db {\n  provider = "sqlite"\n  url = "file:./db/app.db"\n}\n',
    },
    expected: { db: "db/app.db" },
  },
  {
    name: "drizzle-kit's sqlite dialect with a bare path",
    files: {
      "drizzle.config.ts":
        'export default defineConfig({ dialect: "sqlite", schema: "./src/schema.ts", dbCredentials: { url: "./sqlite.db" } });\n',
    },
    expected: { drizzle: "sqlite.db" },
  },
  {
    name: "drizzle-kit's sqlite dialect through process.env",
    files: {
      ".env": "DB_FILE_NAME=file:local.db\n",
      "drizzle.config.ts":
        'export default defineConfig({ dialect: "sqlite", dbCredentials: { url: process.env.DB_FILE_NAME! } });\n',
    },
    expected: { db_file_name: "local.db" },
  },
  {
    name: "in-memory databases and unconfigured .db files are never sources",
    files: { ".env": "DATABASE_URL=file::memory:\n", "stray.db": "", "data/other.sqlite": "" },
    expected: {},
  },
])("discovery: $name", ({ files: config, expected }) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-discover-");

        for (const [file, text] of Object.entries(config)) write(checkout, file, text);
        const list = yield* listIn(checkout);

        expect(files(list)).toEqual(
          Object.fromEntries(
            Object.entries(expected).map(([name, path]) => [name, ["sqlite", join(checkout, path)]])
          )
        );

        for (const source of list) {
          expect(source.locality).toBe("local");
          expect(source.access).toBe("read");
          expect(source.writes).toBe("off");
        }
      })
    )
  )
);

test("a file outside the checkout is Remote and denied to agents; a link out of the checkout is too", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-local-");
        const elsewhere = yield* tempDir("sq-elsewhere-");
        seedDatabase(join(elsewhere, "shared.db"));
        write(checkout, ".env", `DATABASE_URL=file:${join(elsewhere, "shared.db")}\n`);
        yield* Effect.promise(() =>
          Bun.$`ln -s ${join(elsewhere, "shared.db")} ${join(checkout, "linked.db")}`.quiet()
        );
        write(
          checkout,
          "schema.prisma",
          'datasource linked {\n  provider = "sqlite"\n  url = "file:./linked.db"\n}\n'
        );

        const list = yield* listIn(checkout);

        expect(list.map((source) => [source.name, source.locality, source.access])).toEqual([
          ["app", "remote", "denied"],
          ["linked", "remote", "denied"],
        ]);
      })
    )
  ));

test("saveFile adds a SQLite file by path, renames it, and refuses files that aren't SQLite databases", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-save-");
        seedDatabase(join(checkout, "var/app.db"));
        write(checkout, "notes.txt", "this is not a database, just a long enough text file");

        const result = yield* Effect.gen(function* () {
          const sources = yield* DataSources;
          const save = sources.saveFile!;
          const path = join(checkout, "var/app.db");
          const added = yield* save({ sessionId, name: "Local", path, label });

          const renamed = yield* save({
            sessionId,
            name: "cache",
            previousName: "local",
            path,
            label,
          });

          const refused = yield* Effect.flip(
            save({ sessionId, name: "notes", path: join(checkout, "notes.txt"), label })
          );

          const missing = yield* Effect.flip(
            save({ sessionId, name: "gone", path: join(checkout, "gone.db"), label })
          );

          return { added, renamed, refused, missing, list: yield* sources.list({ sessionId }) };
        }).pipe(Effect.provide(sqliteServices(checkout)));

        expect([result.added.name, result.added.path, result.added.foundIn.kind]).toEqual([
          "local",
          join(checkout, "var/app.db"),
          "manual",
        ]);
        expect(result.list.map((source) => source.name)).toEqual(["cache"]);
        expect(result.refused).toMatchObject({ code: "E-DATA-UNREACHABLE" });
        expect(result.missing).toMatchObject({ code: "E-DATA-UNREACHABLE" });
        expect(existsSync(join(checkout, "gone.db"))).toBe(false);
      })
    )
  ));

test("agents' data_sources output shows the file, never the placeholder server", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const checkout = yield* tempDir("sq-view-");
        write(checkout, ".env", "DATABASE_URL=file:./app.db\n");
        const view = sourcesView(checkout, yield* listIn(checkout));
        const text = view.lines.join("\n") + JSON.stringify(view.data);

        expect(text).toContain(join(checkout, "app.db"));

        for (const placeholder of [`${DATA_FILE_SERVER.host}:`, `"host"`, `"port"`, `"database"`])
          expect(text).not.toContain(placeholder);
      })
    )
  ));
