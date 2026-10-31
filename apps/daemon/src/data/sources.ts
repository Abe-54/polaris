import { realpath } from "node:fs/promises";
import { DataError, DataSource, NotFound, type SessionId } from "@polaris/protocol";
import { Effect, Option, PubSub, Redacted, Semaphore, Stream, Schema } from "effect";
import { paths } from "../paths.ts";
import { HostSecrets } from "../secrets/index.ts";
import { EventStore } from "../store/EventStore.ts";
import { DataSourceAccess } from "./access.ts";
import {
  metadata,
  parseConnection,
  connectionUrl,
  sourceId,
  type Candidate,
} from "./connection.ts";
import { DataPools, sqlOptions } from "./pools.ts";
import { inspectPrivileges } from "./privileges.ts";
import { localityProbe } from "./listener.ts";
import { discover } from "./discovery.ts";
import { dataPasswords } from "./passwords.ts";
import { dataFailure, openStorage, sourceStorage } from "./storage.ts";
import type { DataSources } from "./index.ts";

const unknownSource = () =>
  new DataError({
    code: "E-DATA-UNKNOWN-SOURCE",
    message: "No data source by that name in this checkout.",
    fix: "List the checkout's data sources again.",
  });

export const sourceDependencies = Effect.gen(function* () {
  const store = yield* EventStore;
  const secrets = yield* HostSecrets;
  const access = yield* DataSourceAccess;

  return {
    secrets,
    access,
    path: paths().data,
    checkout: (sessionId: SessionId) =>
      Effect.flatMap(store.model, (model) => {
        const record = model.sessions.get(sessionId);

        return record
          ? Effect.succeed(record.session.cwd)
          : Effect.fail(new NotFound({ what: "session", id: sessionId }));
      }),
  };
});

type SaveInput = Parameters<DataSources["Service"]["save"]>[0] & {
  readonly previousName?: string;
  readonly passwordAction?: "keep" | "clear" | "set";
};

/** Public construction goes through DataSources.layer; options supply boundary fakes in fixture tests. */
export const sources = Effect.fnUntraced(function* (options: {
  readonly path: string;
  readonly discovery?: typeof discover;
  readonly checkout: (sessionId: SessionId) => Effect.Effect<string, NotFound>;
  readonly secrets: HostSecrets["Service"];
  readonly access: DataSourceAccess["Service"];
}): Effect.fn.Return<DataSources["Service"], DataError, import("effect").Scope.Scope> {
  const db = yield* openStorage(options.path);
  const storage = sourceStorage(db);
  const passwords = dataPasswords(options.secrets);
  const changes = yield* PubSub.sliding<string>(64);
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
  const lock = yield* Semaphore.make(1);
  const pools = new DataPools();
  yield* Effect.addFinalizer(() => Effect.promise(() => pools.close()));
  const privilegeWarnings = new Map<string, ReadonlyArray<string>>();

  const privilegeKey = (source: DataSource, connection: import("./connection.ts").DataConnection) =>
    Bun.CryptoHasher.hash("sha256", JSON.stringify(sqlOptions(source, connection)), "hex");

  const secret = <A, E>(effect: Effect.Effect<A, E>) => Effect.mapError(effect, dataFailure);

  const candidates = Effect.fnUntraced(function* (checkout: string) {
    const discovered = yield* Effect.tryPromise({
      try: (signal) => (options.discovery ?? discover)(checkout, signal),
      catch: dataFailure,
    }).pipe(Effect.timeout(2000), Effect.mapError(dataFailure));

    return yield* lock.withPermit(
      Effect.gen(function* () {
        const manual = yield* storage.manual(checkout);
        const manualNames = new Set(manual.map((item) => item.name));
        const items = discovered.filter((item) => !manualNames.has(item.name));

        for (const item of manual) {
          const password = yield* secret(passwords.get(item.id));
          items.push({
            name: item.name,
            url: connectionUrl(
              { ...item, user: item.user ?? "" },
              Option.match(password, { onNone: () => "", onSome: Redacted.value })
            ),
            foundIn: { kind: "manual" },
          });
        }

        return items;
      })
    );
  });

  const checkoutPath = (sessionId: SessionId) =>
    options.checkout(sessionId).pipe(
      Effect.catchTag("NotFound", () => Effect.fail(unknownSource())),
      Effect.flatMap((path) => Effect.tryPromise({ try: () => realpath(path), catch: dataFailure }))
    );

  const catalog = Effect.fnUntraced(function* (sessionId: SessionId) {
    const checkout = yield* checkoutPath(sessionId);
    const items = yield* candidates(checkout);

    const result: { source: DataSource; candidate: Candidate }[] = [];
    const probe = localityProbe(checkout);

    for (const candidate of items) {
      const parsed = parseConnection(candidate);

      if (!parsed) continue;

      const locality = yield* Effect.tryPromise({
        try: () => probe(parsed.connection, candidate),
        catch: dataFailure,
      }).pipe(Effect.timeoutOption(1500), Effect.map(Option.getOrElse(() => "remote" as const)));

      const source = metadata(checkout, candidate, locality);

      if (!source) continue;
      const label = yield* lock.withPermit(storage.label(checkout, source));
      const policy = yield* options.access.read({ sessionId, source });
      const warnings = privilegeWarnings.get(privilegeKey(source, parsed.connection));
      result.push({
        source: new DataSource({
          ...Schema.encodeSync(DataSource)(source),
          ...policy,
          label: label ?? source.label,
          ...(warnings === undefined ? undefined : { privilegeWarnings: warnings }),
        }),
        candidate,
      });
    }

    return result.sort((a, b) => a.source.name.localeCompare(b.source.name));
  });

  const list = Effect.fnUntraced(function* ({ sessionId }: { sessionId: SessionId }) {
    return (yield* catalog(sessionId)).map((item) => item.source);
  });

  const find = Effect.fnUntraced(function* (input: { sessionId: SessionId; source: string }) {
    const entry = (yield* catalog(input.sessionId)).find(
      (item) => item.source.name === input.source || item.source.id === input.source
    );

    if (!entry) return yield* unknownSource();

    return entry.source;
  });

  const resolve = Effect.fnUntraced(function* (input: { sessionId: SessionId; source: string }) {
    const entry = (yield* catalog(input.sessionId)).find(
      (item) => item.source.name === input.source || item.source.id === input.source
    );

    if (!entry) return yield* unknownSource();
    const { source, candidate } = entry;

    const parsed = parseConnection(candidate);

    if (!parsed) return yield* unknownSource();

    return { source, connection: parsed.connection, matchUrl: candidate.url };
  });

  const updatePassword = Effect.fnUntraced(function* (
    input: SaveInput,
    id: string,
    previousId: string | undefined
  ) {
    const action = input.passwordAction ?? (input.password === undefined ? "keep" : "set");

    if (action === "clear") return yield* secret(passwords.remove(id));

    if (action === "set") {
      if (input.password === undefined) return yield* dataFailure();

      return yield* secret(passwords.set(id, input.password));
    }

    if (!previousId) return yield* secret(passwords.remove(id));

    if (previousId === id) return;
    const previous = yield* secret(passwords.get(previousId));

    if (Option.isSome(previous)) yield* secret(passwords.set(id, previous.value));
  });

  const save = Effect.fnUntraced(function* (input: SaveInput) {
    const checkout = yield* checkoutPath(input.sessionId);

    const discovered = yield* Effect.tryPromise({
      try: (signal) => (options.discovery ?? discover)(checkout, signal),
      catch: dataFailure,
    }).pipe(Effect.timeout(2000), Effect.mapError(dataFailure));

    const id = yield* lock.withPermit(
      Effect.gen(function* () {
        const name = input.name.trim().toLowerCase();

        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return yield* unknownSource();
        const id = sourceId(checkout, name);

        const submitted = {
          id,
          name,
          engine: input.engine,
          host: input.host,
          port: input.port,
          database: input.database,
          user: input.user,
        };

        const validated = yield* Effect.try({
          try: () =>
            metadata(checkout, {
              name,
              url: connectionUrl(submitted, ""),
              foundIn: { kind: "manual" },
            }),
          catch: dataFailure,
        });

        if (!validated) return yield* unknownSource();

        const item = {
          id,
          name,
          engine: validated.engine,
          host: validated.host,
          port: validated.port,
          database: validated.database,
          user: validated.user ?? "",
        };

        const manual = yield* storage.manual(checkout);
        const previousName = input.previousName?.trim().toLowerCase();
        const previous = manual.find((entry) => entry.name === previousName);

        if (previousName && !previous) return yield* unknownSource();

        const taken =
          manual.some((entry) => entry.name === name && entry.id !== previous?.id) ||
          (!previous && discovered.some((entry) => entry.name === name));

        if (taken)
          return yield* new DataError({
            code: "E-DATA-UNKNOWN-SOURCE",
            message: "A data source already uses that name.",
            fix: "Choose a different name or edit the existing data source.",
          });
        const action = input.passwordAction ?? (input.password === undefined ? "keep" : "set");

        if (
          action === "keep" &&
          previous &&
          (previous.engine !== item.engine ||
            previous.host !== item.host ||
            previous.port !== item.port ||
            previous.user !== item.user)
        )
          return yield* new DataError({
            code: "E-DATA-DENIED",
            message: "A changed server or user needs an explicit password choice.",
            fix: "Set a password or choose to clear it.",
          });
        const before = yield* secret(passwords.get(id));
        yield* updatePassword(input, id, previous?.id);
        yield* storage.save(checkout, item, input.label, previous?.id).pipe(
          Effect.tapError(() =>
            Option.match(before, {
              onNone: () => secret(passwords.remove(id)),
              onSome: (password) => secret(passwords.set(id, password)),
            })
          )
        );

        if (previous && previous.id !== id) yield* secret(passwords.remove(previous.id));
        yield* PubSub.publish(changes, checkout);

        return id;
      })
    );

    return yield* find({ sessionId: input.sessionId, source: id });
  });

  const remove = Effect.fnUntraced(function* (
    input: Parameters<DataSources["Service"]["remove"]>[0]
  ) {
    const checkout = yield* checkoutPath(input.sessionId);
    const source = yield* find(input);

    if (source.foundIn.kind !== "manual") return yield* unknownSource();
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* secret(passwords.remove(source.id));
        yield* storage.remove(checkout, source.id);
        yield* PubSub.publish(changes, checkout);
      })
    );
  });

  const label = Effect.fnUntraced(function* (
    input: Parameters<DataSources["Service"]["label"]>[0]
  ) {
    const checkout = yield* checkoutPath(input.sessionId);
    const source = yield* find(input);
    yield* lock.withPermit(storage.setLabel(checkout, source, input.label));
    yield* PubSub.publish(changes, checkout);

    return yield* find(input);
  });

  const refresh = Effect.fnUntraced(function* (input: { sessionId: SessionId }) {
    const snapshot = yield* list(input);
    const checkout = yield* checkoutPath(input.sessionId);
    yield* PubSub.publish(changes, checkout);

    return snapshot;
  });

  return {
    inspect: Effect.fnUntraced(function* (source, connection) {
      const warnings = yield* Effect.tryPromise({
        try: (signal) => inspectPrivileges(pools, source, connection, signal),
        catch: dataFailure,
      }).pipe(Effect.catch(() => Effect.succeed(["Privileges could not be checked"])));

      const key = privilegeKey(source, connection);

      if (JSON.stringify(privilegeWarnings.get(key)) === JSON.stringify(warnings)) return;

      if (privilegeWarnings.size >= 64)
        privilegeWarnings.delete(privilegeWarnings.keys().next().value!);
      privilegeWarnings.set(key, warnings);
      yield* PubSub.publish(changes, "*");
    }),
    access: Effect.fnUntraced(function* (input) {
      const checkout = yield* checkoutPath(input.sessionId);
      const source = yield* find(input);

      if (options.access.change === undefined)
        return yield* new DataError({
          code: "E-DATA-DENIED",
          message: "Data source access cannot be changed here.",
          fix: "Connect to the current Daemon.",
        });
      yield* options.access.change(source, input.writes, input.revoke);
      yield* PubSub.publish(changes, checkout);

      return yield* find(input);
    }),
    list,
    refresh,
    resolve,
    save,
    remove,
    label,
    watch: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const checkout = yield* checkoutPath(input.sessionId);
          const subscription = yield* PubSub.subscribe(changes);

          return Stream.concat(
            Stream.fromEffect(list(input)),
            Stream.merge(
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((path) => path === "*" || path === checkout)
              ),
              (options.access.changes ?? Stream.empty).pipe(Stream.map(() => checkout))
            ).pipe(Stream.mapEffect(() => list(input)))
          );
        })
      ),
  };
});
