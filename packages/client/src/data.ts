/** Data calls on a live Host connection; capability checks support older Daemons. */
import {
  DATA_CAPABILITY,
  DATA_WRITE_CAPABILITY,
  SCHEMA_DIFF_CAPABILITY,
  type GetDataSchemaDiff,
  Unsupported,
  type WatchDataSources,
  type WatchDataQueryLog,
  type DescribeData,
  type QueryData,
  type CommitDataEdits,
  type SaveDataSource,
  type SaveDataFileSource,
  type RemoveDataSource,
  type LabelDataSource,
  type QueryDataStream,
  type PageDataQueryLog,
  type SetDataSourceAccess,
} from "@polaris/protocol";
import { Effect, Stream } from "effect";
import type { LiveSession } from "./HostConnection.ts";

type Input<R extends { readonly payloadSchema: { readonly Type: unknown } }> =
  R["payloadSchema"]["Type"];

export const supportsData = (session: Pick<LiveSession, "capabilities">): boolean =>
  session.capabilities.includes(DATA_CAPABILITY);

export type DataSession = Pick<LiveSession, "capabilities"> & {
  readonly client: Pick<
    LiveSession["client"],
    | "data.sources.watch"
    | "data.schemaDiff"
    | "data.describe"
    | "data.edits.commit"
    | "data.query"
    | "data.queryLog.watch"
    | "data.source.save"
    | "data.source.saveFile"
    | "data.source.remove"
    | "data.source.label"
    | "data.query.stream"
    | "data.queryLog.page"
    | "data.source.access"
  >;
};

const unsupported = () => Effect.fail(new Unsupported({ capability: DATA_CAPABILITY }));

/** On older Daemons watches end without a snapshot; callers must check supportsData before waiting. */
export const watchDataSources = (session: DataSession, input: Input<typeof WatchDataSources>) =>
  supportsData(session) ? session.client["data.sources.watch"](input) : Stream.empty;

export const watchDataQueryLog = (session: DataSession, input: Input<typeof WatchDataQueryLog>) =>
  supportsData(session) ? session.client["data.queryLog.watch"](input) : Stream.empty;

export const describeData = (session: DataSession, input: Input<typeof DescribeData>) =>
  supportsData(session) ? session.client["data.describe"](input) : unsupported();

export const queryData = (session: DataSession, input: Input<typeof QueryData>) =>
  supportsData(session) ? session.client["data.query"](input) : unsupported();

export const saveDataSource = (session: DataSession, input: Input<typeof SaveDataSource>) =>
  supportsData(session) ? session.client["data.source.save"](input) : unsupported();

/** The capability a Daemon advertises once it serves SQLite sources and `data.source.saveFile`. */
export const DATA_SQLITE_CAPABILITY = "data.sqlite";

export const supportsSqlite = (session: Pick<LiveSession, "capabilities">): boolean =>
  session.capabilities.includes(DATA_SQLITE_CAPABILITY);

export const saveDataFileSource = (
  session: DataSession,
  input: Input<typeof SaveDataFileSource>
) =>
  supportsSqlite(session)
    ? session.client["data.source.saveFile"](input)
    : Effect.fail(new Unsupported({ capability: DATA_SQLITE_CAPABILITY }));

export const removeDataSource = (session: DataSession, input: Input<typeof RemoveDataSource>) =>
  supportsData(session) ? session.client["data.source.remove"](input) : unsupported();

export const labelDataSource = (session: DataSession, input: Input<typeof LabelDataSource>) =>
  supportsData(session) ? session.client["data.source.label"](input) : unsupported();

/** Desktop cancellation closes this stream and interrupts the upstream RPC scope. */
export const queryDataStream = (session: DataSession, input: Input<typeof QueryDataStream>) =>
  supportsData(session)
    ? session.client["data.query.stream"](input)
    : Stream.fail(new Unsupported({ capability: DATA_CAPABILITY }));

export const pageDataQueryLog = (session: DataSession, input: Input<typeof PageDataQueryLog>) =>
  supportsData(session) ? session.client["data.queryLog.page"](input) : unsupported();

export const setDataSourceAccess = (
  session: DataSession,
  input: Input<typeof SetDataSourceAccess>
) => (supportsData(session) ? session.client["data.source.access"](input) : unsupported());

export const supportsDataWrites = (session: Pick<LiveSession, "capabilities">): boolean =>
  session.capabilities.includes(DATA_WRITE_CAPABILITY);

export const commitDataEdits = (session: DataSession, input: Input<typeof CommitDataEdits>) =>
  supportsDataWrites(session)
    ? session.client["data.edits.commit"](input)
    : Effect.fail(new Unsupported({ capability: DATA_WRITE_CAPABILITY }));

export const getDataSchemaDiff = (session: DataSession, input: Input<typeof GetDataSchemaDiff>) =>
  session.capabilities.includes(SCHEMA_DIFF_CAPABILITY)
    ? session.client["data.schemaDiff"](input)
    : Effect.fail(new Unsupported({ capability: SCHEMA_DIFF_CAPABILITY }));
