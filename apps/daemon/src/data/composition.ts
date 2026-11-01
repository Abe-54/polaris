import { Layer } from "effect";
import { DataDatabase } from "./database.ts";
import { DataApprovals } from "./approvals.ts";
import { SchemaSnapshots } from "./schemaSnapshotService.ts";
import { QueryLog } from "./queryLog.ts";
import { DataSources, DataQueries } from "./services.ts";
import { DataSourceAccess } from "./access.ts";
import { HostSecrets } from "../secrets/index.ts";

export const dataServices = Layer.merge(DataQueries.layer, SchemaSnapshots.layer).pipe(
  Layer.provideMerge(DataSources.layer),
  Layer.provideMerge(DataSourceAccess.live),
  Layer.provideMerge(QueryLog.layer),
  Layer.provideMerge(DataApprovals.layer),
  Layer.provideMerge(DataDatabase.layer),
  Layer.provideMerge(HostSecrets.layer)
);
