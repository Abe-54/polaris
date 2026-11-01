import { existsSync } from "node:fs";
import { join } from "node:path";
import { DataRpcs, Unsupported } from "@polaris/protocol";
import { Context, Deferred, Effect, Layer, Predicate, Stream } from "effect";
import { DataApprovals } from "../data/approvalService.ts";
import { DataSources, DataQueries } from "../data/services.ts";
import { SchemaSnapshots } from "../data/schemaSnapshotService.ts";
import { migrationCheckout } from "../data/schemaMigrations.ts";
import { EventStore } from "../store/EventStore.ts";
import { polarisHome } from "../paths.ts";
import { cacheDaemonBuild, lazyRpcLayer } from "./lazy.ts";

/** One scoped Data graph shared by Client, MCP and event-driven snapshot requests. */
export const lazyData = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    let loaded = false;
    let started = false;

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        started = true;
        const { dataServices } = yield* Effect.promise(() => import("../data/composition.ts"));

        const built = yield* Layer.buildWithMemoMap(dataServices, memoMap, scope).pipe(
          Effect.provideService(EventStore, store),
          Effect.orDie
        );

        loaded = true;

        return {
          sources: Context.get(built, DataSources),
          queries: Context.get(built, DataQueries),
          snapshots: Context.get(built, SchemaSnapshots),
          approvals: Context.get(built, DataApprovals),
        };
      })
    );

    // Existing storage needs its normal approval recovery and orphan snapshot cleanup before serve.
    if (existsSync(join(polarisHome(), "data.sqlite"))) yield* load;

    const ready = yield* Deferred.make<void>();

    const followMigrations = Effect.scoped(
      Effect.gen(function* () {
        const events = yield* store.subscribe({
          filter: (item) =>
            !loaded &&
            Predicate.isTagged(item, "Event") &&
            Predicate.isTagged(item.envelope.event, "TurnStarted"),
        });

        yield* Deferred.succeed(ready, undefined);

        yield* events.pipe(
          Stream.runForEach((item) =>
            Effect.gen(function* () {
              if (
                !Predicate.isTagged(item, "Event") ||
                !Predicate.isTagged(item.envelope.event, "TurnStarted")
              )
                return;
              const turn = item.envelope.event.turn;
              const record = (yield* store.model).sessions.get(turn.sessionId);

              if (
                record === undefined ||
                !(yield* Effect.promise(() => migrationCheckout(record.session.cwd)))
              )
                return;
              const services = yield* load;
              yield* services.snapshots.begin?.(turn).pipe(Effect.ignore) ?? Effect.void;
            })
          )
        );
      })
    );

    yield* followMigrations.pipe(Effect.forever, Effect.forkIn(scope));
    yield* Deferred.await(ready);

    return Context.make(
      DataSources,
      DataSources.of({
        list: (input) => Effect.flatMap(load, (s) => s.sources.list(input)),
        refresh: (input) => Effect.flatMap(load, (s) => s.sources.refresh(input)),
        resolve: (input) => Effect.flatMap(load, (s) => s.sources.resolve(input)),
        inspect: (source, connection) =>
          Effect.flatMap(load, (s) => s.sources.inspect?.(source, connection) ?? Effect.void),
        watch: (input) => Stream.unwrap(Effect.map(load, (s) => s.sources.watch(input))),
        save: (input) => Effect.flatMap(load, (s) => s.sources.save(input)),
        saveFile: (input) =>
          Effect.flatMap(load, (s) =>
            s.sources.saveFile
              ? s.sources.saveFile(input)
              : Effect.fail(new Unsupported({ capability: "data.sqlite" }))
          ),
        remove: (input) => Effect.flatMap(load, (s) => s.sources.remove(input)),
        label: (input) => Effect.flatMap(load, (s) => s.sources.label(input)),
        access: (input) => Effect.flatMap(load, (s) => s.sources.access(input)),
      })
    ).pipe(
      Context.add(
        DataApprovals,
        DataApprovals.of({
          changes: Stream.unwrap(Effect.map(load, (s) => s.approvals.changes)),
          read: (source) => Effect.flatMap(load, (s) => s.approvals.read(source)),
          require: (...args) => Effect.flatMap(load, (s) => s.approvals.require(...args)),
          awaitApproval: (...args) =>
            Effect.flatMap(load, (s) => s.approvals.awaitApproval(...args)),
          change: (...args) => Effect.flatMap(load, (s) => s.approvals.change(...args)),
          writes: {
            lookup: (...args) => Effect.flatMap(load, (s) => s.approvals.writes.lookup(...args)),
            open: (...args) => Effect.flatMap(load, (s) => s.approvals.writes.open(...args)),
            claim: (...args) => Effect.flatMap(load, (s) => s.approvals.writes.claim(...args)),
            fail: (...args) => Effect.flatMap(load, (s) => s.approvals.writes.fail(...args)),
            finish: (...args) => Effect.flatMap(load, (s) => s.approvals.writes.finish(...args)),
          },
        })
      ),
      Context.add(
        DataQueries,
        DataQueries.of({
          execute: (input) => Effect.flatMap(load, (s) => s.queries.execute(input)),
          commitEdits: (input) => Effect.flatMap(load, (s) => s.queries.commitEdits(input)),
          describe: (input) => Effect.flatMap(load, (s) => s.queries.describe(input)),
          query: (input) => Effect.flatMap(load, (s) => s.queries.query(input)),
          queryStream: (input) =>
            Stream.unwrap(Effect.map(load, (s) => s.queries.queryStream(input))),
          watchLog: (input) => Stream.unwrap(Effect.map(load, (s) => s.queries.watchLog(input))),
          pageLog: (input) => Effect.flatMap(load, (s) => s.queries.pageLog(input)),
          awaitApproval: (id, timeout) =>
            Effect.flatMap(load, (s) => s.queries.awaitApproval(id, timeout)),
          recordOutside: (input) => Effect.flatMap(load, (s) => s.queries.recordOutside(input)),
        })
      ),
      Context.add(
        SchemaSnapshots,
        SchemaSnapshots.of({
          get: (input) => Effect.flatMap(load, (s) => s.snapshots.get(input)),
          remove: (id) =>
            Effect.suspend(() =>
              started ? Effect.flatMap(load, (s) => s.snapshots.remove(id)) : Effect.void
            ),
        })
      )
    );
  })
);

export const lazyDataHandlers = Layer.fromBuild((memoMap, scope) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<DataSources | DataQueries | SchemaSnapshots>();

    const load = yield* cacheDaemonBuild(
      Effect.gen(function* () {
        const { DataRpcsLive } = yield* Effect.promise(() => import("../data/index.ts"));

        return yield* Layer.buildWithMemoMap(DataRpcsLive, memoMap, scope).pipe(
          Effect.provide(context)
        );
      })
    );

    return yield* Layer.buildWithMemoMap(lazyRpcLayer(DataRpcs, load), memoMap, scope);
  })
);
