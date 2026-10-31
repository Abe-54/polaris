import {
  DATA_CAPABILITY,
  DataError,
  DataSource,
  NotFound,
  Unsupported,
  type SessionId,
} from "@polaris/protocol";
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
  const secret = <A, E>(effect: Effect.Effect<A, E>) => Effect.mapError(effect, dataFailure);

  const candidates = Effect.fnUntraced(function* (checkout: string) {
    const discovered = yield* Effect.tryPromise({
      try: () => discover(checkout),
      catch: dataFailure,
    });

    const manual = yield* storage.manual(checkout);
    const manualNames = new Set(manual.map((item) => item.name));

    return { discovered: discovered.filter((item) => !manualNames.has(item.name)), manual };
  });

  const checkoutPath = (sessionId: SessionId) =>
    options
      .checkout(sessionId)
      .pipe(Effect.catchTag("NotFound", () => Effect.fail(unknownSource())));

  const catalog = Effect.fnUntraced(function* (sessionId: SessionId) {
    const checkout = yield* checkoutPath(sessionId);
    const { discovered, manual } = yield* candidates(checkout);

    const items: Candidate[] = [
      ...discovered,
      ...manual.map((item) => ({
        name: item.name,
        url: connectionUrl({ ...item, user: item.user ?? "" }, ""),
        foundIn: { kind: "manual" } as const,
      })),
    ];

    const result: { source: DataSource; candidate: Candidate }[] = [];

    for (const candidate of items) {
      const source = metadata(checkout, candidate);

      if (!source) continue;
      const label = yield* storage.label(checkout, source.id);
      const policy = yield* options.access.read({ sessionId, source });
      result.push({
        source: new DataSource({
          ...Schema.encodeSync(DataSource)(source),
          ...policy,
          label: label ?? source.label,
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

  const resolve = (input: { sessionId: SessionId; source: string }) =>
    lock.withPermit(
      Effect.gen(function* () {
        const entry = (yield* catalog(input.sessionId)).find(
          (item) => item.source.name === input.source || item.source.id === input.source
        );

        if (!entry) return yield* unknownSource();
        const { source, candidate } = entry;

        const parsed = parseConnection(candidate);

        if (!parsed) return yield* unknownSource();

        if (source.foundIn.kind !== "manual")
          return { source, connection: parsed.connection, url: candidate.url };
        const password = yield* secret(passwords.get(source.id));

        return {
          source,
          connection: {
            ...parsed.connection,
            password: Option.getOrElse(password, () => Redacted.make("")),
          },
          url: connectionUrl(
            {
              engine: source.engine,
              host: source.host,
              port: source.port,
              database: source.database,
              user: source.user ?? "",
            },
            Option.match(password, { onNone: () => "", onSome: Redacted.value })
          ),
        };
      })
    );

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

    if (!previousId || previousId === id) return;
    const previous = yield* secret(passwords.get(previousId));

    if (Option.isSome(previous)) yield* secret(passwords.set(id, previous.value));
  });

  const save = (input: SaveInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        const checkout = yield* checkoutPath(input.sessionId);
        const name = input.name.trim().toLowerCase();

        if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return yield* unknownSource();
        const id = sourceId(checkout, name);

        const item = {
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
            metadata(checkout, { name, url: connectionUrl(item, ""), foundIn: { kind: "manual" } }),
          catch: dataFailure,
        });

        if (!validated) return yield* unknownSource();

        const manual = yield* storage.manual(checkout);
        const previousName = input.previousName?.trim().toLowerCase();
        const previous = manual.find((entry) => entry.name === (previousName ?? name));

        if (previousName && !previous) return yield* unknownSource();

        if (previous && previous.id !== id && manual.some((entry) => entry.id === id))
          return yield* unknownSource();
        yield* updatePassword(input, id, previous?.id);
        yield* storage.save(checkout, item, input.label, previous?.id);

        if (previous && previous.id !== id) yield* secret(passwords.remove(previous.id));
        yield* PubSub.publish(changes, checkout);

        return yield* find({ sessionId: input.sessionId, source: id });
      })
    );

  const remove: DataSources["Service"]["remove"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const checkout = yield* checkoutPath(input.sessionId);
        const source = yield* find(input);

        if (source.foundIn.kind !== "manual") return yield* unknownSource();
        yield* secret(passwords.remove(source.id));
        yield* storage.remove(checkout, source.id);
        yield* PubSub.publish(changes, checkout);
      })
    );

  const label: DataSources["Service"]["label"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const checkout = yield* checkoutPath(input.sessionId);
        const source = yield* find(input);
        yield* storage.setLabel(checkout, source.id, input.label);
        yield* PubSub.publish(changes, checkout);

        return yield* find(input);
      })
    );

  return {
    list: (input) => lock.withPermit(list(input)),
    resolve,
    access: () => Effect.fail(new Unsupported({ capability: DATA_CAPABILITY })),
    save,
    remove,
    label,
    watch: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const checkout = yield* checkoutPath(input.sessionId);
          const subscription = yield* PubSub.subscribe(changes);

          return Stream.concat(
            Stream.fromEffect(lock.withPermit(list(input))),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((path) => path === checkout),
              Stream.mapEffect(() => lock.withPermit(list(input)))
            )
          );
        })
      ),
  };
});
