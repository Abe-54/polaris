import { open, realpath } from "node:fs/promises";
import {
  DATA_FILE_SERVER,
  DataError,
  DataSource,
  NotFound,
  type SaveDataFileSource,
  type SessionId,
  type WorkspaceId,
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
import { DataPools, sqlOptions } from "./pools.ts";
import { inspectPrivileges } from "./privileges.ts";
import { localityProbe } from "./listener.ts";
import { discover } from "./discovery.ts";
import { cachedDiscovery } from "./discoveryCache.ts";
import { dataPasswords } from "./passwords.ts";
import { dataFailure, openStorage, sourceStorage, type ManualSource } from "./storage.ts";
import { fileLocality, realFile, sqliteFile } from "./sqlite/files.ts";
import { DeveloperModeState } from "../developerMode/service.ts";
import {
  DAEMON_SOURCE_LABEL,
  daemonPolicy,
  daemonSources,
  daemonUnchangeable,
  isDaemonSource,
  type DaemonSources,
} from "./daemonSources.ts";
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
  const developerMode = yield* Effect.serviceOption(DeveloperModeState);

  return {
    secrets,
    access,
    path: paths().data,
    ...Option.match(developerMode, {
      onNone: () => undefined,
      onSome: (mode) => ({
        daemon: {
          sources: daemonSources({ mode: mode.current, changes: mode.changes }),
          workspace: (sessionId: SessionId) =>
            Effect.map(store.model, (model) => model.sessions.get(sessionId)?.session.workspaceId),
        },
      }),
    }),
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

type SaveFileInput = typeof SaveDataFileSource.payloadSchema.Type;

const notSqlite = () =>
  new DataError({
    code: "E-DATA-UNREACHABLE",
    message: "There is no SQLite database file at that path.",
    fix: "Choose an existing SQLite file on this Host.",
  });

/** A regular file that is empty or starts with SQLite's header. */
async function checkSqliteFile(path: string) {
  const handle = await open(path, "r").catch(() => undefined);

  if (handle === undefined) throw notSqlite();

  try {
    const stat = await handle.stat();

    if (!stat.isFile()) throw notSqlite();

    if (stat.size === 0) return;
    const header = Buffer.alloc(16);
    await handle.read(header, 0, 16, 0);

    if (header.toString("latin1") !== "SQLite format 3\0") throw notSqlite();
  } finally {
    await handle.close();
  }
}

const TLS_RANK = ["disable", "allow", "prefer", "require", "verify-ca", "verify-full"] as const;

/** A kept password never moves to a weaker TLS mode than it was saved with. */
const tlsRank = (tls: (typeof TLS_RANK)[number] | undefined) =>
  tls === undefined ? 0 : TLS_RANK.indexOf(tls);

/** Public construction goes through DataSources.layer; options supply boundary fakes in fixture tests. */
export const sources = Effect.fnUntraced(function* (options: {
  readonly path: string;
  readonly discovery?: typeof discover;
  readonly checkout: (sessionId: SessionId) => Effect.Effect<string, NotFound>;
  readonly secrets: HostSecrets["Service"];
  readonly access: DataSourceAccess["Service"];
  /** Daemon Sources while Developer Mode is effective; absent, a checkout lists none. */
  readonly daemon?: {
    readonly sources: DaemonSources;
    readonly workspace: (sessionId: SessionId) => Effect.Effect<WorkspaceId | undefined>;
  };
}): Effect.fn.Return<DataSources["Service"], DataError, import("effect").Scope.Scope> {
  const discoverSources = cachedDiscovery(options.discovery ?? discover);
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
    Bun.CryptoHasher.hash(
      "sha256",
      JSON.stringify(
        source.engine === "sqlite" ? ["sqlite", connection.file] : sqlOptions(source, connection)
      ),
      "hex"
    );

  const secret = <A, E>(effect: Effect.Effect<A, E>) => Effect.mapError(effect, dataFailure);

  const candidates = Effect.fnUntraced(function* (checkout: string) {
    const discovered = yield* Effect.tryPromise({
      try: (signal) => discoverSources(checkout, signal),
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

  /** A SQLite candidate names its file's real path, so locality and every read use the same file. */
  const realCandidate = (candidate: Candidate) =>
    Effect.promise(async () => {
      const file = sqliteFile(Redacted.value(candidate.url));

      if (file === undefined) return candidate;
      const path = await realFile(file);
      const target = { engine: "sqlite", host: "", port: 0, database: "", user: "", path };

      return { ...candidate, url: connectionUrl(target, "") };
    });

  const checkoutPath = (sessionId: SessionId) =>
    options.checkout(sessionId).pipe(
      Effect.catchTag("NotFound", () => Effect.fail(unknownSource())),
      Effect.flatMap((path) => Effect.tryPromise({ try: () => realpath(path), catch: dataFailure }))
    );

  /** Daemon Sources never take the checkout's path rule, labels or approvals. */
  const daemonEntries = Effect.fnUntraced(function* (sessionId: SessionId, checkout: string) {
    const daemon = options.daemon;

    if (daemon === undefined) return [];
    const { items, agents } = yield* daemon.sources.candidates(yield* daemon.workspace(sessionId));
    const policy = daemonPolicy(agents);

    return items.flatMap((candidate) => {
      // Remote, so a path that skipped the Daemon Source checks would deny it rather than read it.
      const source = metadata(checkout, candidate, "remote");

      if (!source) return [];
      const encoded = Schema.encodeSync(DataSource)(source);
      const listed = { ...encoded, ...policy, label: DAEMON_SOURCE_LABEL };

      return [{ source: new DataSource(listed), candidate }];
    });
  });

  const catalog = Effect.fnUntraced(function* (sessionId: SessionId) {
    const checkout = yield* checkoutPath(sessionId);
    const items = yield* Effect.forEach(yield* candidates(checkout), realCandidate);

    const result: { source: DataSource; candidate: Candidate }[] = [
      ...(yield* daemonEntries(sessionId, checkout)),
    ];

    const probe = localityProbe(checkout);

    for (const candidate of items) {
      const parsed = parseConnection(candidate);

      if (!parsed) continue;

      const file = parsed.connection.file;

      const locality = yield* Effect.tryPromise({
        try: () =>
          file === undefined ? probe(parsed.connection, candidate) : fileLocality(checkout, file),
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

  /** The manual entry being edited, after checking the new name is free in this checkout. */
  const claimName = Effect.fnUntraced(function* (
    checkout: string,
    name: string,
    rawPrevious: string | undefined,
    discovered: ReadonlyArray<Candidate>
  ) {
    const manual = yield* storage.manual(checkout);
    const previousName = rawPrevious?.trim().toLowerCase();
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

    return previous;
  });

  const discoverFor = (checkout: string) =>
    Effect.tryPromise({
      try: (signal) => discoverSources(checkout, signal),
      catch: dataFailure,
    }).pipe(Effect.timeout(2000), Effect.mapError(dataFailure));

  const saveFile = Effect.fnUntraced(function* (input: SaveFileInput) {
    const checkout = yield* checkoutPath(input.sessionId);
    const discovered = yield* discoverFor(checkout);
    const name = input.name.trim().toLowerCase();

    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return yield* unknownSource();
    yield* Effect.tryPromise({
      try: () => checkSqliteFile(input.path),
      catch: (error) => (error instanceof DataError ? error : notSqlite()),
    });

    const id = yield* lock.withPermit(
      Effect.gen(function* () {
        const id = sourceId(checkout, name);
        const previous = yield* claimName(checkout, name, input.previousName, discovered);

        const item: ManualSource = {
          id,
          name,
          engine: "sqlite",
          ...DATA_FILE_SERVER,
          path: input.path,
        };

        yield* secret(passwords.remove(id));
        yield* storage.save(checkout, item, input.label, previous?.id);

        if (previous && previous.id !== id) yield* secret(passwords.remove(previous.id));
        yield* PubSub.publish(changes, checkout);

        return id;
      })
    );

    return yield* find({ sessionId: input.sessionId, source: id });
  });

  const save = Effect.fnUntraced(function* (input: SaveInput) {
    const checkout = yield* checkoutPath(input.sessionId);

    const discovered = yield* discoverFor(checkout);

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
          tls: input.tls,
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
          ...(validated.tls === undefined ? undefined : { tls: validated.tls }),
        };

        const previous = yield* claimName(checkout, name, input.previousName, discovered);
        const action = input.passwordAction ?? (input.password === undefined ? "keep" : "set");

        if (
          action === "keep" &&
          previous &&
          (previous.engine !== item.engine ||
            previous.host !== item.host ||
            previous.port !== item.port ||
            previous.user !== item.user ||
            tlsRank(item.tls) < tlsRank(previous.tls))
        )
          return yield* new DataError({
            code: "E-DATA-DENIED",
            message: "A changed server, user or weaker TLS mode needs an explicit password choice.",
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

    if (isDaemonSource(source)) return yield* daemonUnchangeable();

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

    if (isDaemonSource(source)) return yield* daemonUnchangeable();
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
      // SQLite has no users or grants to warn about.
      if (source.engine === "sqlite") return;

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

      if (isDaemonSource(source)) return yield* daemonUnchangeable();

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
    saveFile,
    remove,
    label,
    watch: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const checkout = yield* checkoutPath(input.sessionId);
          const subscription = yield* PubSub.subscribe(changes);

          // Developer Mode's changes start with the current mode, so they also list the first snapshot.
          const first = options.daemon?.sources.changes ?? Stream.succeed(undefined);

          return Stream.mergeAll(
            [
              first,
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((path) => path === "*" || path === checkout),
                Stream.map(() => undefined)
              ),
              options.access.changes ?? Stream.empty,
            ],
            { concurrency: "unbounded" }
          ).pipe(Stream.mapEffect(() => list(input)));
        })
      ),
  };
});
