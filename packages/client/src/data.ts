/** Data calls on a live Host connection; capability checks support older Daemons. */
import {
  DATA_CAPABILITY,
  Unsupported,
  type WatchDataSources,
  type WatchDataQueryLog,
  type DescribeData,
  type QueryData,
  type SaveDataSource,
  type RemoveDataSource,
  type LabelDataSource,
  type DecideDataApproval,
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
    | "data.describe"
    | "data.query"
    | "data.queryLog.watch"
    | "data.source.save"
    | "data.source.remove"
    | "data.source.label"
    | "data.approval.decide"
  >;
};

const unsupported = () => Effect.fail(new Unsupported({ capability: DATA_CAPABILITY }));

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

export const removeDataSource = (session: DataSession, input: Input<typeof RemoveDataSource>) =>
  supportsData(session) ? session.client["data.source.remove"](input) : unsupported();

export const labelDataSource = (session: DataSession, input: Input<typeof LabelDataSource>) =>
  supportsData(session) ? session.client["data.source.label"](input) : unsupported();

export const decideDataApproval = (
  session: DataSession,
  input: Input<typeof DecideDataApproval>
) => (supportsData(session) ? session.client["data.approval.decide"](input) : unsupported());
