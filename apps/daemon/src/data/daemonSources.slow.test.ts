/** Daemon Sources over a real Daemon home: shown by Developer Mode, read-only, live (ENG-714). */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DataError, type DataSource, WorkspaceId } from "@polaris/protocol";
import { Effect, Fiber, Layer, Stream } from "effect";
import { developerMode, makeTestDeveloperMode } from "../traces/self/testing.ts";
import { fileSecrets } from "../secrets/index.ts";
import { DataSourceAccess } from "./access.ts";
import { daemonSources } from "./daemonSources.ts";
import { DataQueries, DataSources } from "./index.ts";
import { QueryLog } from "./queryLog.ts";
import { sources } from "./sources.ts";
import { approvalLayer, started } from "./approvals.testing.ts";
import { DeveloperModeState } from "../developerMode/service.ts";
import { seeded, sessionId, tempDir, turn } from "./sqlite/sqlite.testing.ts";

const DAEMON_FILES = ["state", "data", "traces", "usage", "extensions", "linked-devices", "mcp"];

/** A Daemon home as the Daemon leaves it: WAL databases, their -wal/-shm, and other files. */
const daemonHome = (home: string) => {
  for (const name of DAEMON_FILES) {
    const db = new Database(join(home, `${name}.sqlite`), { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, body TEXT)");
    db.exec("INSERT INTO events (body) VALUES ('first')");
    db.close();
  }

  writeFileSync(join(home, "daemon.json"), "{}");
  mkdirSync(join(home, "logs"));
  mkdirSync(join(home, "dir.sqlite"));
};

const names = (list: ReadonlyArray<DataSource>) =>
  list.flatMap((source) => (source.foundIn.kind === "daemon" ? [source.name] : []));

/** DataSources and DataQueries over `checkout`, with Daemon Sources from `home` and a settable mode. */
const withDaemon = <A, E>(
  body: (input: {
    readonly home: string;
    readonly checkout: string;
    readonly queries: DataQueries["Service"];
    readonly sources: DataSources["Service"];
    readonly set: (mode: ReturnType<typeof developerMode>) => Effect.Effect<void>;
  }) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDir("ds-");
        const home = join(root, "home");
        const checkout = join(root, "checkout");
        mkdirSync(home);
        mkdirSync(checkout);
        daemonHome(home);
        const mode = yield* makeTestDeveloperMode();

        const dataSources = Layer.effect(
          DataSources,
          Effect.gen(function* () {
            const access = yield* DataSourceAccess;
            const state = yield* Effect.provide(Effect.service(DeveloperModeState), mode.layer);

            return yield* sources({
              path: join(root, "user-data.sqlite"),
              secrets: fileSecrets(join(root, "secrets")),
              access,
              checkout: () => Effect.succeed(checkout),
              daemon: {
                sources: daemonSources({
                  mode: state.current,
                  changes: state.changes,
                  home: () => home,
                }),
                workspace: () => Effect.succeed(started.session.workspaceId),
              },
            });
          })
        ).pipe(Layer.provide(DataSourceAccess.live));

        const services = DataQueries.layer.pipe(
          Layer.provideMerge(Layer.merge(dataSources, QueryLog.layer)),
          Layer.provideMerge(approvalLayer())
        );

        return yield* Effect.gen(function* () {
          yield* seeded(checkout);

          return yield* body({
            home,
            checkout,
            queries: yield* DataQueries,
            sources: yield* DataSources,
            set: mode.set,
          });
        }).pipe(Effect.provide(services));
      })
    )
  );

/** On, with this session's Workspace as the Polaris Workspace, so agents may read them. */
const on = developerMode({ stored: true, polarisWorkspaceId: started.session.workspaceId });

const agent = { sessionId, tool: "query", turn } as const;

test("every Daemon SQLite file is a read-only Daemon Source only while Developer Mode is on", () =>
  withDaemon(({ sources, set }) =>
    Effect.gen(function* () {
      expect(names(yield* sources.list({ sessionId }))).toEqual([]);

      yield* set(on);

      const listed = (yield* sources.list({ sessionId })).filter(
        (source) => source.foundIn.kind === "daemon"
      );

      expect(listed.map((source) => source.name).sort()).toEqual(
        DAEMON_FILES.map((name) => `Daemon · ${name}`).sort()
      );
      expect(listed.find((source) => source.name === "Daemon · state")).toMatchObject({
        engine: "sqlite",
        access: "read",
        writes: "off",
        label: { text: "DAEMON", colour: "grey" },
        foundIn: { kind: "daemon", file: "state.sqlite" },
      });

      yield* set(developerMode());

      expect(names(yield* sources.list({ sessionId }))).toEqual([]);
    })
  ));

test("a new Daemon file appears on the next list, without a watcher", () =>
  withDaemon(({ sources, set, home }) =>
    Effect.gen(function* () {
      yield* set(on);
      new Database(join(home, "browser-cdp.sqlite"), { create: true }).close();

      expect(names(yield* sources.list({ sessionId }))).toContain("Daemon · browser-cdp");
    })
  ));

test("the Data watch adds and drops Daemon Sources live as Developer Mode changes", () =>
  withDaemon(({ sources, set }) =>
    Effect.gen(function* () {
      const seen: string[][] = [];

      const fiber = yield* sources.watch({ sessionId }).pipe(
        Stream.map(names),
        Stream.tap((list) => Effect.sync(() => seen.push([...list]))),
        Stream.take(3),
        Stream.runDrain,
        Effect.forkChild
      );

      const waitFor = (count: number) =>
        Effect.gen(function* () {
          while (seen.length < count) yield* Effect.sleep(5);
        });

      yield* waitFor(1);
      yield* set(on);
      yield* waitFor(2);
      yield* set(developerMode());
      yield* Fiber.join(fiber);

      expect(seen.map((list) => list.includes("Daemon · state"))).toEqual([false, true, false]);
    })
  ));

test("agents query a Daemon Source while Developer Mode is on, and lose it when it turns off", () =>
  withDaemon(({ queries, set }) =>
    Effect.gen(function* () {
      yield* set(on);

      const result = yield* queries.query({
        ...agent,
        source: "Daemon · state",
        sql: "SELECT body FROM events",
      });

      expect(result.rows).toEqual([["first"]]);

      yield* set(developerMode());

      const gone = yield* Effect.flip(
        queries.query({ ...agent, source: "Daemon · state", sql: "SELECT 1" })
      );

      expect(gone).toMatchObject({ code: "E-DATA-UNKNOWN-SOURCE" });
    })
  ));

test("Daemon Sources show only in the Polaris Workspace's checkouts when there is one", () =>
  withDaemon(({ sources, set }) =>
    Effect.gen(function* () {
      yield* set(developerMode({ stored: true, polarisWorkspaceId: WorkspaceId.make("w_other") }));

      expect(names(yield* sources.list({ sessionId }))).toEqual([]);

      yield* set(developerMode({ stored: true, polarisWorkspaceId: started.session.workspaceId }));

      expect(names(yield* sources.list({ sessionId }))).toContain("Daemon · state");
    })
  ));

test("execute, grid edits and write statements are refused in the Daemon; the file is unchanged", () =>
  withDaemon(({ queries, sources, set, home }) =>
    Effect.gen(function* () {
      yield* set(on);
      const source = "Daemon · state";

      const execute = yield* Effect.flip(
        queries.execute({
          sessionId,
          source,
          tool: "execute",
          turn,
          sql: "DELETE FROM events",
          reason: "Clear it",
        })
      );

      const edits = yield* Effect.flip(
        queries.commitEdits({
          sessionId,
          source,
          table: { schema: "main", name: "events" },
          primaryKey: ["id"],
          edits: [{ key: [1], column: "body", before: "first", value: "changed" }],
        })
      );

      for (const error of [execute, edits]) {
        expect(error).toBeInstanceOf(DataError);
        expect(error).toMatchObject({
          code: "E-DATA-READ-ONLY",
          message: "Daemon Sources can never be written to.",
        });
      }

      for (const sql of [
        "DELETE FROM events",
        "SELECT 1; DELETE FROM events",
        `VACUUM INTO '${join(home, "copy.sqlite")}'`,
      ])
        expect(yield* Effect.flip(queries.query({ ...agent, source, sql }))).toBeInstanceOf(
          DataError
        );

      for (const change of [
        sources.label({ sessionId, source, label: { text: "MINE", colour: "red" } }),
        sources.remove({ sessionId, source }),
        sources.access({ sessionId, source, revoke: true }),
      ])
        expect(yield* Effect.flip(change)).toMatchObject({ code: "E-DATA-READ-ONLY" });

      const db = new Database(join(home, "state.sqlite"), { readonly: true });

      expect(db.query("SELECT body FROM events").values()).toEqual([["first"]]);
      db.close();
    })
  ));

// Each query starts a SQLite child process, which takes seconds on CI's macOS and Windows runners.
test(
  "the Daemon's own writes go on while Data reads its WAL database, and nothing checkpoints",
  () =>
    withDaemon(({ queries, set, home }) =>
      Effect.gen(function* () {
        yield* set(on);
        const file = join(home, "state.sqlite");
        const writer = new Database(file);
        writer.exec("PRAGMA journal_mode = WAL");
        writer.exec("PRAGMA wal_autocheckpoint = 0");
        writer.exec("PRAGMA busy_timeout = 0");
        const insert = writer.prepare("INSERT INTO events (body) VALUES (?)");
        // The writer's open transaction is held across a read; a lock taken by the reader would fail it.
        writer.exec("BEGIN IMMEDIATE");
        insert.run("during");

        const read = yield* queries.query({
          ...agent,
          source: "Daemon · state",
          sql: "SELECT count(*) FROM events",
        });

        writer.exec("COMMIT");

        expect(read.rows).toEqual([[1]]);

        for (let i = 0; i < 5; i++) {
          insert.run(`write ${i}`);

          const after = yield* queries.query({
            ...agent,
            source: "Daemon · state",
            sql: "SELECT count(*) FROM events",
          });

          expect(after.rows).toEqual([[i + 3]]);
        }

        // A checkpoint by the reader would have moved these frames into the database and reset the log.
        expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);
        expect(writer.query("PRAGMA wal_checkpoint(PASSIVE)").values()[0]![1]).toBeGreaterThan(0);
        insert.finalize();
        writer.close();
      })
    ),
  30_000
);

test("a user's SQLite file outside the checkout is still denied to agents, even in the Daemon's home", () =>
  withDaemon(({ queries, sources, set, home, checkout }) =>
    Effect.gen(function* () {
      yield* set(on);
      symlinkSync(join(home, "state.sqlite"), join(checkout, "linked.db"));
      writeFileSync(join(checkout, ".env"), "DATABASE_URL=file:./linked.db\n");
      yield* sources.saveFile!({
        sessionId,
        name: "mine",
        path: join(home, "usage.sqlite"),
        label: { text: "", colour: "none" },
      });

      for (const source of ["app", "mine"]) {
        const listed = (yield* sources.list({ sessionId })).find((s) => s.name === source);

        expect(listed).toMatchObject({ locality: "remote", access: "denied" });
        expect(
          yield* Effect.flip(queries.query({ ...agent, source, sql: "SELECT 1" }))
        ).toMatchObject({ code: "E-DATA-DENIED" });
      }
    })
  ));

test("with no Polaris Workspace, agents can't read Daemon Sources, but the user's Data view can", () =>
  withDaemon(({ queries, sources, set }) =>
    Effect.gen(function* () {
      yield* set(developerMode({ stored: true }));
      const source = "Daemon · state";
      const listed = (yield* sources.list({ sessionId })).find((s) => s.name === source);

      expect(listed).toMatchObject({ access: "denied", writes: "off" });

      for (const read of [
        Effect.asVoid(queries.query({ ...agent, source, sql: "SELECT body FROM events" })),
        Effect.asVoid(queries.describe({ sessionId, source, tool: "describe", turn })),
      ])
        expect(yield* Effect.flip(read)).toMatchObject({
          code: "E-DATA-DENIED",
          message: "Agents read Daemon Sources only in the Polaris Workspace's checkouts.",
        });

      const user = yield* queries.query({ sessionId, source, sql: "SELECT body FROM events" });

      expect(user.rows).toEqual([["first"]]);
    })
  ));
