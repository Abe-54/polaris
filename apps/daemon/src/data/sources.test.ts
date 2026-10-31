import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SessionId, NotFound } from "@polaris/protocol";
import { Effect, Fiber, Option, Redacted, Stream } from "effect";
import { SecretStorageError, fileSecrets } from "../secrets/index.ts";
import { DataSourceAccess } from "./access.ts";
import { sources } from "./sources.ts";

const sessionId = SessionId.make("one");

const second = SessionId.make("two");

const label = { text: "STAGING", colour: "blue" } as const;

const password = `pa ss'"@🗝`;

const input = {
  sessionId,
  name: "manual",
  engine: "postgres",
  host: "db.example.test",
  port: 5432,
  database: "ledger",
  user: "user",
  password: Redacted.make(password),
  label,
} as const;

const fixture = Effect.gen(function* () {
  const root = mkdtempSync("/tmp/data-sources-");
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(root, { recursive: true, force: true }))
  );
  const secrets = fileSecrets(join(root, "secrets"));
  const access = yield* DataSourceAccess.pipe(Effect.provide(DataSourceAccess.layer));

  const options = {
    path: join(root, "data.sqlite"),
    checkout: (id: SessionId) =>
      Effect.succeed(id === SessionId.make("other") ? join(root, "other") : root),
    secrets,
    access,
  };

  return { root, options, secrets };
});

test("manual sources and labels survive restart, share a checkout, isolate another, and redact every response", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { root, options, secrets } = yield* fixture;

        const source = yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* sources(options);

            return yield* service.save(input);
          })
        );

        expect(source).toMatchObject({
          name: "manual",
          locality: "remote",
          access: "needs-approval",
          label,
        });
        expect(statSync(options.path).mode & 0o777).toBe(0o600);
        expect(readFileSync(options.path).includes(Buffer.from(password))).toBe(false);
        expect(readFileSync(options.path).includes(Buffer.from("postgres://"))).toBe(false);
        const raw = yield* secrets.get(`data/${source.id}`);
        expect(Option.isSome(raw) && Redacted.value(raw.value)).toBe(
          Buffer.from(password).toString("base64")
        );
        const service = yield* sources(options);
        expect(yield* service.list({ sessionId: second })).toEqual([source]);
        expect(yield* service.list({ sessionId: SessionId.make("other") })).toEqual([]);
        const resolved = yield* service.resolve({ sessionId: second, source: source.id });
        expect(decodeURIComponent(new URL(Redacted.value(resolved.url)).password)).toBe(password);
        const override = { text: "READ ME", colour: "green" } as const;
        const labelled = yield* service.label({ sessionId, source: "manual", label: override });
        expect(labelled.label).toEqual(override);
        const { password: _password, ...withoutPassword } = input;
        const saved = yield* service.save({ ...withoutPassword, label: override });
        expect(
          JSON.stringify([source, labelled, saved, yield* service.list({ sessionId })])
        ).not.toMatch(/postgres:\/\/|pa ss/);
        yield* service.remove({ sessionId: second, source: source.id });
        expect(yield* service.list({ sessionId })).toEqual([]);
        expect(Option.isNone(yield* secrets.get(`data/${source.id}`))).toBe(true);
        expect(readdirSync(join(root, "secrets", "data"))).toEqual([]);
      })
    )
  ));

test("watch emits real checkout snapshots on save, label and remove without polling", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options } = yield* fixture;
        const service = yield* sources(options);
        const snapshots: ReadonlyArray<import("@polaris/protocol").DataSource>[] = [];

        const watcher = yield* service.watch({ sessionId: second }).pipe(
          Stream.take(4),
          Stream.runForEach((snapshot) =>
            Effect.sync(() => {
              snapshots.push(snapshot);
            })
          ),
          Effect.forkChild
        );

        while (snapshots.length < 1) yield* Effect.yieldNow;
        yield* service.save(input);

        while (snapshots.length < 2) yield* Effect.yieldNow;
        yield* service.label({
          sessionId,
          source: "manual",
          label: { text: "Test", colour: "tan" },
        });

        while (snapshots.length < 3) yield* Effect.yieldNow;
        yield* service.remove({ sessionId, source: "manual" });
        yield* Fiber.join(watcher);
        expect(snapshots.map((list) => list.map((source) => source.label.text))).toEqual([
          [],
          ["STAGING"],
          ["Test"],
          [],
        ]);
      })
    )
  ));

test("resolve re-reads changed credentials and target, preserving label but recomputing access", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { root, options } = yield* fixture;
        writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:first@localhost/dev");
        const service = yield* sources(options);
        const first = yield* service.resolve({ sessionId, source: "app" });
        expect(first.source.access).toBe("read");
        yield* service.label({ sessionId, source: "app", label });
        writeFileSync(join(root, ".env"), "DATABASE_URL=postgres://u:second@remote.test/prod");
        const next = yield* service.resolve({ sessionId, source: first.source.id });
        expect(next.source).toMatchObject({
          host: "remote.test",
          database: "prod",
          access: "needs-approval",
          label,
        });
        expect(new URL(Redacted.value(next.url)).password).toBe("second");
        expect(readFileSync(options.path).includes(Buffer.from("first"))).toBe(false);
        expect(readFileSync(options.path).includes(Buffer.from("second"))).toBe(false);
      })
    )
  ));

test("password encoding does not relax token validation in other namespaces", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { secrets, options } = yield* fixture;
        expect(
          yield* Effect.flip(secrets.set("voice/deepgram", Redacted.make(password)))
        ).toBeInstanceOf(SecretStorageError);
        const service = yield* sources(options);
        const saved = yield* service.save({ ...input, password: Redacted.make("") });
        expect(
          new URL(Redacted.value((yield* service.resolve({ sessionId, source: saved.id })).url))
            .password
        ).toBe("");
      })
    )
  ));

test("explicit driver options defeat Host PG variables and honour URL query target overrides", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { root, options } = yield* fixture;
        writeFileSync(
          join(root, ".env"),
          "DATABASE_URL=postgres://initial:private@localhost:5432/initial?host=actual.test&port=5544&user=reader&dbname=actual&password=overridden&sslmode=verify-full"
        );
        const service = yield* sources(options);
        const result = yield* service.resolve({ sessionId, source: "app" });
        expect(result.source).toMatchObject({
          host: "actual.test",
          port: 5544,
          user: "reader",
          database: "actual",
          locality: "remote",
        });
        expect(result.connection).toMatchObject({
          hostname: "actual.test",
          port: 5544,
          username: "reader",
          database: "actual",
          tls: "verify-full",
        });
        expect(Redacted.value(result.connection.password)).toBe("overridden");

        const previous = {
          PGHOST: process.env.PGHOST,
          PGDATABASE: process.env.PGDATABASE,
          PGUSER: process.env.PGUSER,
          PGPORT: process.env.PGPORT,
        };

        Object.assign(process.env, {
          PGHOST: "misdirected.test",
          PGDATABASE: "misdirected",
          PGUSER: "wrong",
          PGPORT: "9999",
        });

        try {
          const sql = new Bun.SQL({
            adapter: result.source.engine,
            ...result.connection,
            password: Redacted.value(result.connection.password),
          });

          expect(sql.options).toMatchObject({
            hostname: "actual.test",
            port: 5544,
            username: "reader",
            database: "actual",
          });
          yield* Effect.promise(() => sql.close());
          expect((yield* service.resolve({ sessionId, source: "app" })).source).toEqual(
            result.source
          );
        } finally {
          for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }
      })
    )
  ));

test("the injected policy supplies remembered approval and write state", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options } = yield* fixture;

        const service = yield* sources({
          ...options,
          access: DataSourceAccess.of({
            read: () => Effect.succeed({ access: "denied", writes: "off" }),
          }),
        });

        const saved = yield* service.save(input);
        expect(saved).toMatchObject({ access: "denied", writes: "off" });
        expect((yield* service.resolve({ sessionId, source: saved.id })).source).toMatchObject({
          access: "denied",
          writes: "off",
        });
      })
    )
  ));

test("manual rename/edit keeps its password, then explicit clear removes it", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options, secrets } = yield* fixture;
        const service = yield* sources(options);
        const original = yield* service.save(input);
        const { password: _password, ...withoutPassword } = input;

        const rename = {
          ...withoutPassword,
          name: "renamed",
          previousName: "manual",
          host: "changed.test",
          passwordAction: "keep",
        } as const;

        const renamed = yield* service.save(rename);
        expect((yield* service.list({ sessionId })).map((source) => source.name)).toEqual([
          "renamed",
        ]);
        expect(
          Redacted.value(
            (yield* service.resolve({ sessionId, source: renamed.id })).connection.password
          )
        ).toBe(password);
        expect(Option.isNone(yield* secrets.get(`data/${original.id}`))).toBe(true);
        const clear = { ...rename, previousName: "renamed", passwordAction: "clear" } as const;
        yield* service.save(clear);
        expect(
          Redacted.value(
            (yield* service.resolve({ sessionId, source: "renamed" })).connection.password
          )
        ).toBe("");
        expect(Option.isNone(yield* secrets.get(`data/${renamed.id}`))).toBe(true);
      })
    )
  ));

test("missing session checkouts fail with the Data contract code instead of NotFound", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { options } = yield* fixture;

        const service = yield* sources({
          ...options,
          checkout: () => Effect.fail(new NotFound({ what: "session", id: sessionId })),
        });

        const input = { sessionId, source: "app" };

        const reads = [
          service.list({ sessionId }).pipe(Effect.asVoid),
          service.resolve(input).pipe(Effect.asVoid),
          service.watch(input).pipe(Stream.runDrain),
        ];

        for (const read of reads) {
          expect(yield* Effect.flip(read)).toMatchObject({ code: "E-DATA-UNKNOWN-SOURCE" });
        }
      })
    )
  ));
