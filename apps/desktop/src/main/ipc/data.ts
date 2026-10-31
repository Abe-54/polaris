/** Desktop Data requests use the Client's capability-gated, read-only Query path. */
import {
  describeData,
  queryData,
  saveDataSource,
  removeDataSource,
  labelDataSource,
  pageDataQueryLog,
  setDataSourceAccess,
  type LiveSession,
} from "@polaris/client";
import { DataError, Unsupported, scrubCredentials } from "@polaris/protocol";
import { Effect, Redacted, Schema } from "effect";
import type { IpcError } from "../../shared/api.ts";
import type { RequestInput } from "../../shared/contract.ts";
import { HostDirectory, toIpcError } from "../hosts.ts";

type DataErrorLocation = { position?: number; line?: number };

export const toDataIpcError = (error: {
  readonly _tag: string;
  readonly message: string;
}): IpcError => {
  if (Schema.is(DataError)(error)) {
    const location: DataErrorLocation = {};

    if (error.position !== undefined) location.position = error.position;

    if (error.sqlLine !== undefined) location.line = error.sqlLine;

    return {
      code: error.code,
      message: scrubCredentials(error.message),
      fix: scrubCredentials(error.fix),
      ...location,
    };
  }

  if (Schema.is(Unsupported)(error))
    return {
      code: "Unsupported",
      message: "Data is unavailable on this Host. Upgrade the Daemon to use Data.",
    };

  return toIpcError(error);
};

const onHost = <A, E extends { readonly _tag: string; readonly message: string }>(
  hostKey: string,
  use: (session: LiveSession) => Effect.Effect<A, E>
) =>
  HostDirectory.use((dir) => dir.connection(hostKey)).pipe(
    Effect.flatMap((connection) => connection.session),
    Effect.flatMap(use),
    Effect.mapError(toDataIpcError)
  );

export const dataHandlers = {
  "data.describe": ({ hostKey, ...input }: RequestInput<"data.describe">) =>
    onHost(hostKey, (session) => describeData(session, input)),
  "data.query": ({ hostKey, ...input }: RequestInput<"data.query">) =>
    onHost(hostKey, (session) => queryData(session, input)),
  "data.source.save": ({ hostKey, password, ...input }: RequestInput<"data.source.save">) =>
    onHost(hostKey, (session) =>
      saveDataSource(
        session,
        password === undefined ? input : { ...input, password: Redacted.make(password) }
      )
    ),
  "data.source.remove": ({ hostKey, ...input }: RequestInput<"data.source.remove">) =>
    onHost(hostKey, (session) => removeDataSource(session, input)).pipe(Effect.as(null)),
  "data.source.label": ({ hostKey, ...input }: RequestInput<"data.source.label">) =>
    onHost(hostKey, (session) => labelDataSource(session, input)),
  "data.queryLog.page": ({ hostKey, ...input }: RequestInput<"data.queryLog.page">) =>
    onHost(hostKey, (session) => pageDataQueryLog(session, input)),
  "data.source.access": ({ hostKey, ...input }: RequestInput<"data.source.access">) =>
    onHost(hostKey, (session) => setDataSourceAccess(session, input)),
};
