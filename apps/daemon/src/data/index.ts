/** Data service exports and RPC wiring. Implementations load with their service Layers. */
import { DataRpcs, DataError, Unsupported } from "@polaris/protocol";
import { Effect, Option, Predicate, Stream } from "effect";
import type { NotFound } from "@polaris/protocol";
import type { DataApprovalRequired } from "./approvalRequired.ts";
import { DataSources, DataQueries } from "./services.ts";
import { SchemaSnapshots } from "./schemaSnapshotService.ts";

export { DataSources, DataQueries } from "./services.ts";

export { DataSourceAccess } from "./access.ts";

export type { DataConnection } from "./connection.ts";

type Failure = DataError | NotFound | Unsupported;

const wireFailure = (error: Failure | DataApprovalRequired): DataError | Unsupported => {
  if (Predicate.isTagged(error, "Unsupported") || Predicate.isTagged(error, "DataError"))
    return error;

  return new DataError({
    code: "E-DATA-DENIED",
    message: "This data source is unavailable for this request.",
    fix: "Select an agent session and check its data sources.",
  });
};

export const DataRpcsLive = DataRpcs.toLayer(
  Effect.gen(function* () {
    const sources = yield* DataSources;
    const queries = yield* DataQueries;
    const snapshots = yield* Effect.serviceOption(SchemaSnapshots);

    return {
      "data.schemaDiff": (input) =>
        Option.isSome(snapshots)
          ? snapshots.value.get(input)
          : Effect.fail(new Unsupported({ capability: "data.schemaDiff" })),
      "data.sources.watch": (input) => sources.watch(input).pipe(Stream.mapError(wireFailure)),
      "data.describe": (input) => queries.describe(input).pipe(Effect.mapError(wireFailure)),
      "data.edits.commit": (input) => queries.commitEdits(input).pipe(Effect.mapError(wireFailure)),
      "data.query": (input) => queries.query(input).pipe(Effect.mapError(wireFailure)),
      "data.query.stream": (input) =>
        queries.queryStream(input).pipe(Stream.rechunk(1), Stream.mapError(wireFailure)),
      "data.queryLog.page": (input) => queries.pageLog(input).pipe(Effect.mapError(wireFailure)),
      "data.queryLog.watch": (input) => queries.watchLog(input).pipe(Stream.mapError(wireFailure)),
      "data.source.save": (input) => sources.save(input).pipe(Effect.mapError(wireFailure)),
      "data.source.saveFile": (input) =>
        sources.saveFile
          ? sources.saveFile(input).pipe(Effect.mapError(wireFailure))
          : Effect.fail(new Unsupported({ capability: "data.sqlite" })),
      "data.source.remove": (input) => sources.remove(input).pipe(Effect.mapError(wireFailure)),
      "data.source.label": (input) => sources.label(input).pipe(Effect.mapError(wireFailure)),
      "data.source.access": (input) => sources.access(input).pipe(Effect.mapError(wireFailure)),
    };
  })
);
