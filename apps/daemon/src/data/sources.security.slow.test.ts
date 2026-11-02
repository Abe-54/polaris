import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionId } from "@polaris/protocol";
import { Effect, Fiber, Option, Redacted, Stream } from "effect";
import { sourceId } from "./connection.ts";
import { realpathSync } from "node:fs";
import { discover } from "./discovery.ts";
import { sources } from "./sources.ts";
import { sourceFixture, manualInput as input, sessionId } from "./sources.testing.ts";

const run = (body: Effect.Effect<void, unknown, import("effect").Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(body));

test("R4/F6: an implicit overwrite fails and keeps the old target and password", () =>
  run(
    Effect.gen(function* () {
      const { options } = yield* sourceFixture;
      const service = yield* sources(options);
      yield* service.save({ ...input, password: Redacted.make("production-secret") });
      expect(yield* Effect.flip(service.save({ ...input, host: "127.0.0.1" }))).toMatchObject({
        code: "E-DATA-UNKNOWN-SOURCE",
      });
      const actual = yield* service.resolve({ sessionId, source: input.name });
      expect(actual.source.host).toBe("db.test");
      expect(Redacted.value(actual.connection.password)).toBe("production-secret");
    })
  ));

test.each([
  { host: "127.0.0.1" },
  { port: 5544 },
  { user: "another" },
  { engine: "mysql" as const },
])("F6: keep refuses a changed authentication target: %j", (change) =>
  run(
    Effect.gen(function* () {
      const { options } = yield* sourceFixture;
      const service = yield* sources(options);
      yield* service.save({ ...input, password: Redacted.make("production-secret") });

      const edit = {
        ...input,
        ...change,
        previousName: input.name,
        passwordAction: "keep" as const,
      };

      expect(yield* Effect.flip(service.save(edit))).toMatchObject({ code: "E-DATA-DENIED" });
      expect((yield* service.resolve({ sessionId, source: input.name })).source.host).toBe(
        "db.test"
      );
      yield* service.save({ ...edit, passwordAction: "clear" });
      expect(
        Redacted.value(
          (yield* service.resolve({ sessionId, source: input.name })).connection.password
        )
      ).toBe("");
    })
  )
);

test("F13: checkout symlink and trailing slash share manual metadata and Secure Storage", () =>
  run(
    Effect.gen(function* () {
      const { root, options } = yield* sourceFixture;
      symlinkSync(root, join(root, "alias"), "junction");

      const service = yield* sources({
        ...options,
        checkout: (id) => Effect.succeed(id === sessionId ? `${root}/` : join(root, "alias")),
      });

      const saved = yield* service.save({ ...input, password: Redacted.make("private-password") });

      const alias = yield* service.resolve({
        sessionId: SessionId.make("alias"),
        source: input.name,
      });

      expect(alias.source.id).toBe(saved.id);
      expect(Redacted.value(alias.connection.password)).toBe("private-password");
    })
  ));

test("F13: failed metadata save removes a copied password and leaves the original usable", () =>
  run(
    Effect.gen(function* () {
      const { root, options, secrets } = yield* sourceFixture;
      const service = yield* sources(options);

      const original = yield* service.save({
        ...input,
        password: Redacted.make("private-password"),
      });

      const db = new Database(options.path);

      try {
        db.exec(
          "CREATE TRIGGER reject_rename BEFORE INSERT ON data_manual_sources WHEN json_extract(NEW.value, '$.name') = 'renamed' BEGIN SELECT RAISE(ABORT, 'fixture'); END;"
        );
        expect(
          yield* Effect.flip(
            service.save({
              ...input,
              name: "renamed",
              previousName: input.name,
              passwordAction: "keep",
            })
          )
        ).toMatchObject({ code: "E-DATA-UNREACHABLE" });
        expect(
          Option.isNone(yield* secrets.get(`data/${sourceId(realpathSync(root), "renamed")}`))
        ).toBe(true);
        expect(Option.isSome(yield* secrets.get(`data/${original.id}`))).toBe(true);
        expect(
          Redacted.value(
            (yield* service.resolve({ sessionId, source: input.name })).connection.password
          )
        ).toBe("private-password");
        db.exec("DROP TRIGGER reject_rename");
        const created = yield* service.save({ ...input, name: "renamed" });
        expect(Option.isNone(yield* secrets.get(`data/${created.id}`))).toBe(true);
      } finally {
        db.close();
      }
    })
  ));

test("F9/F11/F14: watch subscription refreshes file edits; resolve exposes only matchUrl and unprobed reachability", () =>
  run(
    Effect.gen(function* () {
      const { root, options } = yield* sourceFixture;
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:secret@before.test/app");
      const service = yield* sources(options);
      const first = yield* service.watch({ sessionId }).pipe(Stream.take(1), Stream.runCollect);
      expect(first[0]?.[0]?.host).toBe("before.test");
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:secret@after.test/app");
      const refreshed = yield* service.watch({ sessionId }).pipe(Stream.take(1), Stream.runCollect);
      expect(refreshed[0]?.[0]?.host).toBe("after.test");
      expect(refreshed[0]?.[0]).not.toHaveProperty("reachable");
      const resolved = yield* service.resolve({ sessionId, source: "app" });
      expect(resolved).not.toHaveProperty("url");
      expect(Redacted.value(resolved.matchUrl)).toContain("after.test");
    })
  ));

test("F14: explicit refresh publishes an edited .env to an already open watch", () =>
  run(
    Effect.gen(function* () {
      const { root, options } = yield* sourceFixture;
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:p@before.test/app");
      const service = yield* sources(options);
      const snapshots: string[] = [];

      const watcher = yield* service.watch({ sessionId }).pipe(
        Stream.take(2),
        Stream.runForEach((items) =>
          Effect.sync(() => {
            snapshots.push(items[0]?.host ?? "missing");
          })
        ),
        Effect.forkChild
      );

      while (snapshots.length === 0) yield* Effect.yieldNow;
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:p@after.test/app");
      const refreshed = yield* service.refresh({ sessionId });
      yield* Fiber.join(watcher);
      expect(refreshed[0]?.host).toBe("after.test");
      expect(snapshots).toEqual(["before.test", "after.test"]);
    })
  ));

test("F1: a stalled checkout times out without taking the Host storage lock", () =>
  run(
    Effect.gen(function* () {
      const { options } = yield* sourceFixture;

      const ready = Promise.withResolvers<void>();

      const service = yield* sources({
        ...options,
        discovery: (checkout, signal) => {
          if (basename(checkout) !== "other") return discover(checkout, signal);
          ready.resolve();

          return new Promise((_, reject) =>
            signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            })
          );
        },
      });

      const stalled = yield* service
        .list({ sessionId: SessionId.make("other") })
        .pipe(Effect.flip, Effect.forkChild);

      yield* Effect.promise(() => ready.promise);
      const started = performance.now();
      const saved = yield* service.save(input);
      expect(saved.name).toBe(input.name);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(yield* Fiber.join(stalled)).toMatchObject({ code: "E-DATA-UNREACHABLE" });
    })
  ));
